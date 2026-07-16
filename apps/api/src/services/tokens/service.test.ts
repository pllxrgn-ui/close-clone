import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';

import { apiTokens, users } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { hashToken } from './hash.ts';
import { TokenNotFoundError, TokenValidationError } from './errors.ts';
import { TokenService } from './service.ts';

/**
 * Task 5c — token lifecycle + authentication (PGlite; D-003). Plaintext-once,
 * hash-only storage, scope round-trip, the revoked/expired validity gate, keyset
 * listing, and the throttled last_used bump. Failure paths included.
 */

const ADMIN = '00000000-0000-4000-8000-00000000c001';

let ctx: TestDb;
const clock = { now: new Date('2026-07-15T12:00:00.000Z') };
let svc: TokenService;

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values({
    id: ADMIN,
    email: 'admin@tokens.test',
    name: 'Token Admin',
    role: 'admin',
    idpSubject: 'idp|tokenadmin',
  });
  svc = new TokenService(ctx.db, () => clock.now);
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  clock.now = new Date('2026-07-15T12:00:00.000Z');
  await ctx.db.execute(sql`DELETE FROM api_tokens`);
});

describe('create', () => {
  test('returns the plaintext once, stores only the sha256 hash, no hash in the view', async () => {
    const { token, plaintext } = await svc.create({
      name: 'CI deploy',
      scopes: ['read:leads', 'write:leads'],
      createdBy: ADMIN,
    });
    expect(plaintext.startsWith('sbk_')).toBe(true);
    expect(token.scopes).toEqual(['read:leads', 'write:leads']);
    expect(token.status).toBe('active');
    expect(token.createdBy).toBe(ADMIN);
    // The view carries no secret material.
    expect(Object.keys(token)).not.toContain('hash');

    const stored = await ctx.db
      .select({ hash: apiTokens.hash })
      .from(apiTokens)
      .where(sql`${apiTokens.id} = ${token.id}`);
    expect(stored[0]!.hash).toBe(hashToken(plaintext));
    expect(stored[0]!.hash).not.toContain(plaintext);
  });

  test('rejects an empty name or an empty scope set', async () => {
    await expect(svc.create({ name: '  ', scopes: ['admin'] })).rejects.toBeInstanceOf(
      TokenValidationError,
    );
    await expect(svc.create({ name: 'x', scopes: [] })).rejects.toBeInstanceOf(
      TokenValidationError,
    );
  });

  test('rejects an expiry in the past', async () => {
    await expect(
      svc.create({ name: 'x', scopes: ['admin'], expiresAt: '2020-01-01T00:00:00.000Z' }),
    ).rejects.toBeInstanceOf(TokenValidationError);
  });
});

describe('authenticate', () => {
  test('a valid token resolves to its identity + scopes', async () => {
    const { plaintext, token } = await svc.create({
      name: 't',
      scopes: ['read:leads'],
      createdBy: ADMIN,
    });
    const outcome = await svc.authenticate(plaintext);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.token.id).toBe(token.id);
      expect(outcome.token.scopes).toEqual(['read:leads']);
      expect(outcome.token.createdBy).toBe(ADMIN);
    }
  });

  test('an unknown token → unknown_token', async () => {
    const outcome = await svc.authenticate('sbk_does_not_exist');
    expect(outcome).toEqual({ ok: false, reason: 'unknown_token' });
  });

  test('a revoked token → revoked_or_expired (carrying the token id for audit)', async () => {
    const { plaintext, token } = await svc.create({ name: 't', scopes: ['admin'] });
    await svc.revoke(token.id);
    const outcome = await svc.authenticate(plaintext);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('revoked_or_expired');
      expect(outcome.tokenId).toBe(token.id);
    }
  });

  test('a scheduled expiry is valid before, refused at/after the instant', async () => {
    const { plaintext } = await svc.create({
      name: 'ttl',
      scopes: ['read:reports'],
      expiresAt: '2026-07-15T13:00:00.000Z',
    });
    // 12:59 — still valid.
    clock.now = new Date('2026-07-15T12:59:59.000Z');
    expect((await svc.authenticate(plaintext)).ok).toBe(true);
    // 13:00 — expired.
    clock.now = new Date('2026-07-15T13:00:00.000Z');
    const after = await svc.authenticate(plaintext);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('revoked_or_expired');
  });
});

describe('revoke', () => {
  test('is idempotent and reports NOT_FOUND for unknown ids', async () => {
    const { token } = await svc.create({ name: 't', scopes: ['admin'] });
    const first = await svc.revoke(token.id);
    expect(first.status).toBe('revoked');
    expect(first.revokedAt).not.toBeNull();
    const firstRevokedAt = first.revokedAt;
    // Second revoke leaves the original instant intact.
    clock.now = new Date('2026-07-15T14:00:00.000Z');
    const second = await svc.revoke(token.id);
    expect(second.revokedAt).toBe(firstRevokedAt);

    await expect(svc.revoke('00000000-0000-4000-8000-0000000000ff')).rejects.toBeInstanceOf(
      TokenNotFoundError,
    );
  });
});

describe('list', () => {
  test('newest-first, keyset paginated, hash-free', async () => {
    // Three tokens at increasing created_at.
    for (let i = 0; i < 3; i += 1) {
      clock.now = new Date(`2026-07-15T12:0${i}:00.000Z`);
      await svc.create({ name: `t${i}`, scopes: ['read:leads'], createdBy: ADMIN });
    }
    clock.now = new Date('2026-07-15T13:00:00.000Z');
    const page1 = await svc.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]!.name).toBe('t2'); // newest first
    expect(page1.nextCursor).toBeDefined();
    for (const item of page1.items) expect(Object.keys(item)).not.toContain('hash');

    const page2 = await svc.list({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.name).toBe('t0');
    expect(page2.nextCursor).toBeUndefined();
  });

  test('an invalid cursor → TokenValidationError', async () => {
    await expect(svc.list({ cursor: 'not-a-cursor!!' })).rejects.toBeInstanceOf(
      TokenValidationError,
    );
  });
});

describe('touchLastUsed (throttled)', () => {
  test('writes once, then suppresses within the throttle window', async () => {
    const { token } = await svc.create({ name: 't', scopes: ['admin'] });
    clock.now = new Date('2026-07-15T12:00:30.000Z');
    expect(await svc.touchLastUsed(token.id, 60_000)).toBe(true);
    // 20s later, still inside the 60s throttle → no write.
    clock.now = new Date('2026-07-15T12:00:50.000Z');
    expect(await svc.touchLastUsed(token.id, 60_000)).toBe(false);
    // Past the throttle → writes again.
    clock.now = new Date('2026-07-15T12:02:00.000Z');
    expect(await svc.touchLastUsed(token.id, 60_000)).toBe(true);
  });
});
