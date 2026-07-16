import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';

import { auditLog, users } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { registerAdminAuditRoutes } from './admin-audit.ts';

/**
 * Task 5b — `GET /api/v1/admin/audit-log`. Exercises the INJECTED admin guard
 * (allow vs deny → 403), zod validation (400), end-to-end redaction through the
 * HTTP layer, filters, and keyset pagination. RBAC itself is Task 5a; here the
 * guard is a stub so this route is verifiable in isolation and under MOCK_MODE.
 */

const ADMIN = '00000000-0000-4000-8000-0000000000b1';
const TA = '2026-04-01T00:00:00.000Z';
const TB = '2026-04-02T00:00:00.000Z';

const allowGuard: preHandlerHookHandler = async () => {
  /* authorized — fall through to the handler */
};
const denyGuard: preHandlerHookHandler = async (_request, reply) => {
  return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'admin required' } });
};

let ctx: TestDb;
let app: FastifyInstance;
const ids: Record<string, string> = {};

async function seedRow(tag: string, values: typeof auditLog.$inferInsert): Promise<void> {
  const [row] = await ctx.db.insert(auditLog).values(values).returning({ id: auditLog.id });
  if (!row) throw new Error(`seed ${tag} failed`);
  ids[tag] = row.id;
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values({
    id: ADMIN, email: 'admin@x.test', name: 'Admin', role: 'admin', idpSubject: 'idp|admin',
  });
  await seedRow('a1', {
    action: 'auth.login', entity: 'auth', actorType: 'user', actorId: ADMIN, at: TA,
  });
  await seedRow('a2', {
    action: 'admin.compliance_switch_changed', entity: 'email_account', actorType: 'user',
    actorId: ADMIN, at: TB,
    // Raw token material seeded directly — the endpoint must not echo it back.
    before: { address: 'box@x.test', oauthTokens: 'ya29.RAW_OLD' },
    after: { address: 'box@x.test', oauthTokens: 'ya29.RAW_NEW' },
  });

  app = Fastify({ logger: false });
  registerAdminAuditRoutes(app, { db: ctx.db, adminGuard: allowGuard });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('admin guard (injected preHandler)', () => {
  test('allow guard → 200 with the { items } envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-log' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(2);
    // Newest first.
    expect(body.items[0].id).toBe(ids['a2']);
  });

  test('deny guard → 403 and the handler never runs', async () => {
    const denyApp = Fastify({ logger: false });
    registerAdminAuditRoutes(denyApp, { db: ctx.db, adminGuard: denyGuard });
    await denyApp.ready();
    const res = await denyApp.inject({ method: 'GET', url: '/api/v1/admin/audit-log' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    await denyApp.close();
  });
});

describe('redaction through the HTTP layer', () => {
  test('never returns oauth token material in a response body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-log?entity=email_account',
    });
    expect(res.statusCode).toBe(200);
    const item = res.json().items[0];
    expect(item.before.oauthTokens).toBe('[REDACTED]');
    expect(item.after.oauthTokens).toBe('[REDACTED]');
    // Belt-and-suspenders: the raw token strings appear nowhere in the payload.
    expect(res.payload).not.toContain('ya29.RAW_OLD');
    expect(res.payload).not.toContain('ya29.RAW_NEW');
  });
});

describe('filters', () => {
  test('?action= narrows the result set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-log?action=auth.login',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(ids['a1']);
  });
});

describe('validation (400)', () => {
  test('an invalid actorType → VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-log?actorType=wizard',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  test('a malformed cursor → VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-log?cursor=not-a-real-cursor',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('keyset pagination', () => {
  test('limit + cursor walks pages in order', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-log?limit=1' });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.items[0].id).toBe(ids['a2']);
    expect(typeof firstBody.nextCursor).toBe('string');

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit-log?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0].id).toBe(ids['a1']);
    expect(secondBody.nextCursor).toBeUndefined();
  });
});
