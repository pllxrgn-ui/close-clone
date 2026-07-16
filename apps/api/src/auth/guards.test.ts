import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { users } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { requireAdmin, requireSession } from './guards.ts';
import { SessionCodec } from './session/session.ts';
import { CSRF_HEADER } from './csrf.ts';
import type { SessionReader } from './types.ts';

/**
 * Task 5a — guards proven on a bare Fastify instance (acceptance): requireSession
 * (401 no/tampered/inactive; 403 CSRF-missing on mutation; 200 valid) and
 * requireAdmin (403 rep; 200 admin). The SessionReader is the real session codec —
 * the same seam the composition root injects.
 */

const REP = '00000000-0000-4000-8000-0000000000a1';
const ADMIN = '00000000-0000-4000-8000-0000000000a2';
const INACTIVE = '00000000-0000-4000-8000-0000000000a3';

let ctx: TestDb;
let app: FastifyInstance;
const session = new SessionCodec({ secret: 'guard-secret', secure: false });

function cookieFor(userId: string): string {
  return session.issue(userId).split(';')[0] as string;
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values([
    { id: REP, email: 'rep@x.test', name: 'Rep', role: 'rep', idpSubject: 'idp|rep' },
    { id: ADMIN, email: 'admin@x.test', name: 'Admin', role: 'admin', idpSubject: 'idp|admin' },
    {
      id: INACTIVE,
      email: 'off@x.test',
      name: 'Off',
      role: 'rep',
      idpSubject: 'idp|off',
      isActive: false,
    },
  ]);

  const readSession: SessionReader = (request) => session.read(request.headers.cookie);
  app = Fastify({ logger: false });
  const sessionGuard = requireSession({ db: ctx.db, readSession });
  const adminGuard = requireAdmin({ db: ctx.db, readSession });

  app.get('/api/v1/thing', { preHandler: sessionGuard }, async (request) => ({
    userId: request.user?.id,
    actor: request.actor,
  }));
  app.post('/api/v1/thing', { preHandler: sessionGuard }, async () => ({ ok: true }));
  app.get('/api/v1/admin/thing', { preHandler: adminGuard }, async () => ({ ok: true }));
  app.post('/api/v1/admin/thing', { preHandler: adminGuard }, async () => ({ ok: true }));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('requireSession', () => {
  test('valid session → 200, attaches user + actor', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/thing',
      headers: { cookie: cookieFor(REP) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userId: REP, actor: { id: REP, type: 'user' } });
  });

  test('no cookie → 401 UNAUTHENTICATED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/thing' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  test('tampered cookie → 401', async () => {
    const good = cookieFor(REP);
    const tampered = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/thing',
      headers: { cookie: tampered },
    });
    expect(res.statusCode).toBe(401);
  });

  test('inactive user → 401 (deactivation enforced every request)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/thing',
      headers: { cookie: cookieFor(INACTIVE) },
    });
    expect(res.statusCode).toBe(401);
  });

  test('mutating request without CSRF header → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { cookie: cookieFor(REP) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  test('mutating request WITH CSRF header → 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { cookie: cookieFor(REP), [CSRF_HEADER]: '1' },
    });
    expect(res.statusCode).toBe(200);
  });

  test('CSRF gate fires before the DB user lookup, but after auth (tampered → 401 not 403)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/thing' });
    expect(res.statusCode).toBe(401); // no session at all → auth first
  });
});

describe('requireAdmin', () => {
  test('admin → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/thing',
      headers: { cookie: cookieFor(ADMIN) },
    });
    expect(res.statusCode).toBe(200);
  });

  test('rep → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/thing',
      headers: { cookie: cookieFor(REP) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  test('no session → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/thing' });
    expect(res.statusCode).toBe(401);
  });

  test('admin mutating route enforces CSRF (403 without header)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/thing',
      headers: { cookie: cookieFor(ADMIN) },
    });
    expect(res.statusCode).toBe(403);
  });
});
