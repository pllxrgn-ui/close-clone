import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { auditLog, users } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { registerAdminExportRoutes } from './admin-export.ts';

/**
 * Task 5g — `POST /api/v1/admin/exports`. Exercises the injected admin guard
 * (allow → 201, deny → 403), body validation (400), the on-disk file_ref, and
 * the export.started/completed audit trail written through the route.
 */

const allowGuard: preHandlerHookHandler = async () => {
  /* authorized */
};
const denyGuard: preHandlerHookHandler = async (_request, reply) => {
  return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'admin required' } });
};

let ctx: TestDb;
let app: FastifyInstance;
let exportsRoot: string;

beforeAll(async () => {
  ctx = await createTestDb();
  exportsRoot = await mkdtemp(join(tmpdir(), 'sb-route-export-'));
  await ctx.db.insert(users).values({
    email: 'seed@x.test',
    name: 'Seed',
    role: 'admin',
    idpSubject: 'idp|seed',
  });

  app = Fastify({ logger: false });
  registerAdminExportRoutes(app, { db: ctx.db, adminGuard: allowGuard, exportsRoot });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
  await rm(exportsRoot, { recursive: true, force: true });
});

describe('admin guard (injected preHandler)', () => {
  test('deny guard → 403 and the handler never runs', async () => {
    const denyApp = Fastify({ logger: false });
    registerAdminExportRoutes(denyApp, { db: ctx.db, adminGuard: denyGuard, exportsRoot });
    await denyApp.ready();
    const res = await denyApp.inject({ method: 'POST', url: '/api/v1/admin/exports', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    await denyApp.close();
  });
});

describe('export run', () => {
  test('allow guard → 201 with a manifest and files on disk', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/exports',
      payload: { format: 'jsonl' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.exportId).toBe('string');
    expect(typeof body.fileRef).toBe('string');
    expect(body.format).toBe('jsonl');
    expect(Array.isArray(body.entities)).toBe(true);

    // The file_ref directory has the per-entity files.
    expect(existsSync(join(body.fileRef, 'users.jsonl'))).toBe(true);
    const usersEntity = (body.entities as { name: string; rows: number }[]).find(
      (e) => e.name === 'users',
    );
    expect(usersEntity?.rows).toBe(1);
  });

  test('writes export.started and export.completed audit rows', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/exports',
      payload: { format: 'jsonl' },
    });
    const body = res.json();
    const started = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'export.started'));
    const completed = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'export.completed'));
    // At least this run's pair is present, tagged with its export id.
    expect(started.some((r) => r.entityId === body.exportId)).toBe(true);
    expect(completed.some((r) => r.entityId === body.exportId)).toBe(true);
  });
});

describe('validation (400)', () => {
  test('an unknown format → VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/exports',
      payload: { format: 'xml' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});
