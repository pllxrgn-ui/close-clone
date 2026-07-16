import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';

import { apiTokens, auditLog, users } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { PostgresRateLimiter } from './rate-limit.ts';
import { TokenService } from './service.ts';
import { createBearerAuthPreHandler, createSessionRateLimitPreHandler } from './pre-handler.ts';

/**
 * Task 5c — the bearer preHandler pipeline over real HTTP (Fastify inject; PGlite).
 * Failure paths first: missing/unknown/revoked token, wrong scope, rate-limit
 * boundary; then the success path (identity attached, last_used bumped, audit
 * rows written for real-credential denials).
 */

const ADMIN = '00000000-0000-4000-8000-00000000d001';

let ctx: TestDb;
let app: FastifyInstance;
let svc: TokenService;
const clock = { ms: Date.parse('2026-07-15T12:00:00.000Z') };

async function auditCount(reason: string): Promise<number> {
  const res = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'auth.denied'), eq(auditLog.reason, reason)));
  return Number(res[0]!.n);
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values({
    id: ADMIN,
    email: 'admin@ph.test',
    name: 'Admin',
    role: 'admin',
    idpSubject: 'idp|ph-admin',
  });
  svc = new TokenService(ctx.db, () => new Date(clock.ms));
  // Tight token limit (2/window) so the boundary is cheap to hit.
  const rateLimiter = new PostgresRateLimiter(
    ctx.db,
    { token: { limit: 2, windowMs: 60_000 }, session: { limit: 3, windowMs: 60_000 } },
    () => clock.ms,
  );

  const bearer = createBearerAuthPreHandler(
    { db: ctx.db, tokens: svc, rateLimiter },
    { scope: 'read:leads' },
  );
  const sessionLimiter = createSessionRateLimitPreHandler({
    rateLimiter,
    sessionKeyFor: (req) => {
      const u = req.headers['x-user'];
      return typeof u === 'string' ? u : null;
    },
  });

  app = Fastify({ logger: false });
  app.get('/protected', { preHandler: bearer }, async (request) => ({
    ok: true,
    tokenId: request.apiToken?.id ?? null,
    scopes: request.apiToken?.scopes ?? [],
  }));
  app.get('/web', { preHandler: sessionLimiter }, async () => ({ ok: true }));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

function bearer(plaintext: string): { authorization: string } {
  return { authorization: `Bearer ${plaintext}` };
}

describe('missing / malformed credentials → 401 (no audit noise)', () => {
  test('no Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  test('malformed bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(await auditCount('malformed_token')).toBe(0);
  });
});

describe('real-credential denials → audited', () => {
  test('unknown token → 401 + auth.denied(unknown_token)', async () => {
    const before = await auditCount('unknown_token');
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: bearer('sbk_unknown_but_wellformed_000000000000000000'),
    });
    expect(res.statusCode).toBe(401);
    expect(await auditCount('unknown_token')).toBe(before + 1);
  });

  test('revoked token → 401 + auth.denied(revoked_or_expired)', async () => {
    const { plaintext, token } = await svc.create({
      name: 'to-revoke',
      scopes: ['read:leads'],
      createdBy: ADMIN,
    });
    await svc.revoke(token.id);
    const before = await auditCount('revoked_or_expired');
    const res = await app.inject({ method: 'GET', url: '/protected', headers: bearer(plaintext) });
    expect(res.statusCode).toBe(401);
    expect(await auditCount('revoked_or_expired')).toBe(before + 1);
    // The audit row carries the token id + owning user.
    const rows = await ctx.db
      .select({ entityId: auditLog.entityId, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'auth.denied'), eq(auditLog.reason, 'revoked_or_expired')));
    expect(rows.some((r) => r.entityId === token.id && r.actorId === ADMIN)).toBe(true);
  });

  test('wrong scope → 403 + auth.denied(insufficient_scope) + requiredScope detail', async () => {
    const { plaintext } = await svc.create({
      name: 'reports-only',
      scopes: ['read:reports'],
      createdBy: ADMIN,
    });
    const before = await auditCount('insufficient_scope');
    const res = await app.inject({ method: 'GET', url: '/protected', headers: bearer(plaintext) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(res.json().error.details.requiredScope).toBe('read:leads');
    expect(await auditCount('insufficient_scope')).toBe(before + 1);
  });
});

describe('success path', () => {
  test('a correctly-scoped token → 200 with identity attached + last_used bumped', async () => {
    const { plaintext, token } = await svc.create({
      name: 'good',
      scopes: ['read:leads'],
      createdBy: ADMIN,
    });
    const res = await app.inject({ method: 'GET', url: '/protected', headers: bearer(plaintext) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, tokenId: token.id, scopes: ['read:leads'] });

    const row = await ctx.db
      .select({ lastUsedAt: apiTokens.lastUsedAt })
      .from(apiTokens)
      .where(eq(apiTokens.id, token.id));
    expect(row[0]!.lastUsedAt).not.toBeNull();
  });

  test('admin is a superscope — an admin token reaches a read:leads route', async () => {
    const { plaintext } = await svc.create({
      name: 'admin-tok',
      scopes: ['admin'],
      createdBy: ADMIN,
    });
    const res = await app.inject({ method: 'GET', url: '/protected', headers: bearer(plaintext) });
    expect(res.statusCode).toBe(200);
  });
});

describe('rate limit boundary (exact) → 429 + Retry-After', () => {
  test('the 3rd request in a 2/window bucket is refused', async () => {
    const { plaintext } = await svc.create({
      name: 'rl',
      scopes: ['read:leads'],
      createdBy: ADMIN,
    });
    const h = bearer(plaintext);
    expect((await app.inject({ method: 'GET', url: '/protected', headers: h })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: 'GET', url: '/protected', headers: h })).statusCode).toBe(
      200,
    );
    const before = await auditCount('rate_limited');
    const third = await app.inject({ method: 'GET', url: '/protected', headers: h });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
    expect(third.headers['retry-after']).toBeDefined();
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(await auditCount('rate_limited')).toBe(before + 1);
  });
});

describe('session rate limiter (web)', () => {
  test('generous per-session limit, then 429; no session key ⇒ pass-through', async () => {
    // No key → skipped (200).
    expect((await app.inject({ method: 'GET', url: '/web' })).statusCode).toBe(200);
    // 3/window for sessions; 4th refused.
    const h = { 'x-user': 'web-user-1' };
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/web', headers: h })).statusCode).toBe(200);
    }
    const refused = await app.inject({ method: 'GET', url: '/web', headers: h });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
  });
});
