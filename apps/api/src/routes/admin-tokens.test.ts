import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';

import { users } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { registerAdminTokenRoutes } from './admin-tokens.ts';

/**
 * Task 5c — `/api/v1/admin/tokens` (admin RBAC). Injected guard (allow/deny),
 * plaintext-once create, hash-free list, revoke, and zod validation of scopes.
 */

const ADMIN = '00000000-0000-4000-8000-00000000e001';

const allowGuard: preHandlerHookHandler = async () => {
  /* authorized */
};
const denyGuard: preHandlerHookHandler = async (_request, reply) => {
  return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'admin required' } });
};

let ctx: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values({
    id: ADMIN,
    email: 'admin@rt.test',
    name: 'Admin',
    role: 'admin',
    idpSubject: 'idp|rt-admin',
  });
  app = Fastify({ logger: false });
  registerAdminTokenRoutes(app, {
    db: ctx.db,
    adminGuard: allowGuard,
    resolveActorId: () => ADMIN,
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('admin guard', () => {
  test('deny guard → 403 and the handler never runs', async () => {
    const denyApp = Fastify({ logger: false });
    registerAdminTokenRoutes(denyApp, { db: ctx.db, adminGuard: denyGuard });
    await denyApp.ready();
    const res = await denyApp.inject({
      method: 'POST',
      url: '/api/v1/admin/tokens',
      payload: { name: 'x', scopes: ['admin'] },
    });
    expect(res.statusCode).toBe(403);
    await denyApp.close();
  });
});

describe('create', () => {
  test('201 returns the plaintext once + a hash-free view', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tokens',
      payload: { name: 'CI', scopes: ['read:leads', 'write:leads'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.plaintext).toMatch(/^sbk_/);
    expect(body.token.scopes).toEqual(['read:leads', 'write:leads']);
    expect(body.token.createdBy).toBe(ADMIN);
    expect(body.token).not.toHaveProperty('hash');
    expect(res.payload).not.toContain('"hash"');
  });

  test('an unknown scope → VALIDATION_FAILED (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tokens',
      payload: { name: 'x', scopes: ['read:leads', 'delete:all'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  test('an empty scope set → VALIDATION_FAILED (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tokens',
      payload: { name: 'x', scopes: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('list + revoke', () => {
  test('list never leaks hash; revoke flips status and is idempotent', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tokens',
      payload: { name: 'to-revoke', scopes: ['admin'] },
    });
    const tokenId = created.json().token.id;

    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/tokens' });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json().items)).toBe(true);
    expect(list.payload).not.toContain('"hash"');

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tokens/${tokenId}/revoke`,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().token.status).toBe('revoked');
    expect(revoke.json().token.revokedAt).not.toBeNull();
  });

  test('revoking an unknown id → NOT_FOUND (404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tokens/00000000-0000-4000-8000-0000000000aa/revoke',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
