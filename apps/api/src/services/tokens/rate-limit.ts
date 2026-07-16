import { sql } from 'drizzle-orm';

import type { Db } from '../../db/index.ts';

/**
 * Per-caller fixed-window rate limiter (Task 5c, CONTRACTS §C8 `RATE_LIMITED` 429).
 *
 * Backed by Postgres, NOT Redis (this host has no Redis; DECISIONS D-013 keeps
 * Redis optional). A single row per bucket holds the current window start and a
 * counter; each request is one atomic upsert that either increments the counter
 * (same window) or resets it to 1 (window rolled over). Because the increment and
 * the window-roll decision happen in ONE `INSERT … ON CONFLICT DO UPDATE`, N
 * concurrent requests see a correct serialized count with no read-modify-write
 * race.
 *
 * Two buckets share the mechanism (the limits differ, injected as config):
 *   - `token:<tokenId>`   — the internal API, strict (the task's per-token limit).
 *   - `session:<userId>`  — the web session, generous default.
 *
 * CONTRACT FRICTION (reported upward): C1 has no table for this state, and this
 * module may not add a migration or touch `schema.ts` (both outside the 5c
 * allowlist). It therefore self-provisions `api_rate_limit_windows` via idempotent
 * `CREATE TABLE IF NOT EXISTS` ({@link ensureRateLimitSchema}), called once at
 * composition-root boot and in test setup. The recommended follow-up is to promote
 * the DDL below to a real migration and add the table to C1.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export interface RateLimitRule {
  /** Max requests allowed within one window. */
  limit: number;
  /** Fixed-window length, in milliseconds. */
  windowMs: number;
}

export interface RateLimitConfig {
  /** Internal API tokens (strict). */
  token: RateLimitRule;
  /** Web sessions (generous default). */
  session: RateLimitRule;
}

/**
 * Defaults — overridable via config injection (org_settings-style), so an operator
 * can tune limits without a code change. Generous on the web, tighter per token.
 */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  token: { limit: 120, windowMs: 60_000 }, // 120 req/min per API token
  session: { limit: 600, windowMs: 60_000 }, // 600 req/min per web session
};

export interface RateLimitResult {
  /** True iff this request exceeded the window's allowance. */
  limited: boolean;
  /** Requests counted in the current window (including this one). */
  count: number;
  /** The rule's allowance. */
  limit: number;
  /** Requests still allowed in the current window (0 when limited). */
  remaining: number;
  /** Seconds until the window resets — the C8 `Retry-After` value (0 when allowed). */
  retryAfterSec: number;
  /** Unix ms at which the current window ends. */
  resetAtMs: number;
}

/** The self-provisioned table's DDL (see the module note). Idempotent. */
const CREATE_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS api_rate_limit_windows (
    bucket text PRIMARY KEY,
    window_start timestamptz NOT NULL,
    count integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

/**
 * Ensure the rate-limit table exists. Call once at boot / in test setup. Safe to
 * call repeatedly and concurrently (`IF NOT EXISTS`).
 */
export async function ensureRateLimitSchema(db: Db): Promise<void> {
  await db.execute(CREATE_TABLE_SQL);
}

/**
 * Atomically count this request against `bucket`'s fixed window and report whether
 * it is over the limit. The window is derived from `nowMs` (floored to `windowMs`)
 * so it is deterministic under an injected clock.
 */
export async function consumeRateLimit(
  db: Db,
  bucket: string,
  rule: RateLimitRule,
  nowMs: number,
): Promise<RateLimitResult> {
  const windowStartMs = Math.floor(nowMs / rule.windowMs) * rule.windowMs;
  const resetAtMs = windowStartMs + rule.windowMs;
  const windowStartIso = new Date(windowStartMs).toISOString();

  const result = await db.execute(sql`
    INSERT INTO api_rate_limit_windows AS w (bucket, window_start, count, updated_at)
    VALUES (${bucket}, ${windowStartIso}, 1, now())
    ON CONFLICT (bucket) DO UPDATE SET
      count = CASE WHEN w.window_start = EXCLUDED.window_start THEN w.count + 1 ELSE 1 END,
      window_start = EXCLUDED.window_start,
      updated_at = now()
    RETURNING count
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  const count = Number(rows[0]?.['count'] ?? 0);

  const limited = count > rule.limit;
  return {
    limited,
    count,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSec: limited ? Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)) : 0,
    resetAtMs,
  };
}

/** Bucket-key builders — namespaced so token and session counters never collide. */
export function tokenBucket(tokenId: string): string {
  return `token:${tokenId}`;
}
export function sessionBucket(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * Ergonomic limiter binding a db handle, config, and clock. Memoizes the schema
 * ensure so the first `consume*` call self-provisions and subsequent calls don't.
 */
export class PostgresRateLimiter {
  private readonly db: Db;
  private readonly config: RateLimitConfig;
  private readonly nowMs: () => number;
  private ensured: Promise<void> | null = null;

  constructor(
    db: Db,
    config: RateLimitConfig = DEFAULT_RATE_LIMITS,
    nowMs: () => number = Date.now,
  ) {
    this.db = db;
    this.config = config;
    this.nowMs = nowMs;
  }

  private ensure(): Promise<void> {
    if (this.ensured === null) this.ensured = ensureRateLimitSchema(this.db);
    return this.ensured;
  }

  async consumeToken(tokenId: string): Promise<RateLimitResult> {
    await this.ensure();
    return consumeRateLimit(this.db, tokenBucket(tokenId), this.config.token, this.nowMs());
  }

  async consumeSession(sessionId: string): Promise<RateLimitResult> {
    await this.ensure();
    return consumeRateLimit(this.db, sessionBucket(sessionId), this.config.session, this.nowMs());
  }
}
