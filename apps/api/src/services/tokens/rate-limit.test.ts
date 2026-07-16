import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import {
  DEFAULT_RATE_LIMITS,
  PostgresRateLimiter,
  consumeRateLimit,
  ensureRateLimitSchema,
  tokenBucket,
  type RateLimitRule,
} from './rate-limit.ts';

/**
 * Task 5c — per-bucket fixed-window rate limiting on Postgres (PGlite; D-003).
 * Boundary-exact: N allowed, N+1 refused; window rollover resets; buckets isolate;
 * Retry-After is the seconds to the window edge.
 */

const RULE: RateLimitRule = { limit: 3, windowMs: 1_000 };

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
  await ensureRateLimitSchema(ctx.db);
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM api_rate_limit_windows`);
});

describe('fixed-window boundary (exact)', () => {
  test('exactly `limit` requests pass, the next is refused', async () => {
    const base = 10_000; // aligned to a window start
    const r1 = await consumeRateLimit(ctx.db, tokenBucket('t1'), RULE, base);
    const r2 = await consumeRateLimit(ctx.db, tokenBucket('t1'), RULE, base + 100);
    const r3 = await consumeRateLimit(ctx.db, tokenBucket('t1'), RULE, base + 200);
    const r4 = await consumeRateLimit(ctx.db, tokenBucket('t1'), RULE, base + 300);

    expect([r1.limited, r2.limited, r3.limited]).toEqual([false, false, false]);
    expect([r1.count, r2.count, r3.count]).toEqual([1, 2, 3]);
    expect([r1.remaining, r2.remaining, r3.remaining]).toEqual([2, 1, 0]);

    expect(r4.limited).toBe(true);
    expect(r4.count).toBe(4);
    expect(r4.remaining).toBe(0);
  });

  test('Retry-After counts the seconds to the window edge', async () => {
    const base = 10_000;
    await consumeRateLimit(ctx.db, tokenBucket('t2'), RULE, base);
    await consumeRateLimit(ctx.db, tokenBucket('t2'), RULE, base);
    await consumeRateLimit(ctx.db, tokenBucket('t2'), RULE, base);
    // 350ms into a 1000ms window ⇒ 650ms left ⇒ ceil to 1s.
    const refused = await consumeRateLimit(ctx.db, tokenBucket('t2'), RULE, base + 350);
    expect(refused.limited).toBe(true);
    expect(refused.retryAfterSec).toBe(1);
    expect(refused.resetAtMs).toBe(11_000);
  });
});

describe('window rollover', () => {
  test('a later window resets the counter to 1', async () => {
    const w1 = 10_000;
    for (let i = 0; i < 3; i += 1) await consumeRateLimit(ctx.db, tokenBucket('t3'), RULE, w1);
    const blocked = await consumeRateLimit(ctx.db, tokenBucket('t3'), RULE, w1 + 500);
    expect(blocked.limited).toBe(true);

    // Cross into the next window (t >= 11_000): fresh allowance.
    const next = await consumeRateLimit(ctx.db, tokenBucket('t3'), RULE, 11_200);
    expect(next.limited).toBe(false);
    expect(next.count).toBe(1);
  });
});

describe('bucket isolation', () => {
  test('separate buckets keep independent counters', async () => {
    const base = 20_000;
    for (let i = 0; i < 3; i += 1) await consumeRateLimit(ctx.db, tokenBucket('a'), RULE, base);
    const aBlocked = await consumeRateLimit(ctx.db, tokenBucket('a'), RULE, base);
    const bFresh = await consumeRateLimit(ctx.db, tokenBucket('b'), RULE, base);
    expect(aBlocked.limited).toBe(true);
    expect(bFresh.limited).toBe(false);
  });
});

describe('PostgresRateLimiter', () => {
  test('self-provisions the schema and applies the token rule', async () => {
    const clock = { ms: 30_000 };
    const limiter = new PostgresRateLimiter(
      ctx.db,
      { token: RULE, session: DEFAULT_RATE_LIMITS.session },
      () => clock.ms,
    );
    const first = await limiter.consumeToken('tok');
    expect(first.limited).toBe(false);
    expect(first.limit).toBe(3);
  });
});
