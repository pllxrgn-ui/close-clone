import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.ts';

/**
 * /healthz — readiness probe (Task 5e, ARCHITECTURE §8). A plugin factory the
 * composition root wires; it REPLACES the boot-time liveness stub in `server.ts`
 * (that stub is only used before the DB is wired). Returns
 * `{ ok, checks: { database, queue, emailSyncLag }, version }` with 200/503.
 *
 * Degraded-not-dead semantics (documented, enforced): the probe answers "should
 * traffic keep flowing to this instance", not "is everything perfect".
 *   - database — CRITICAL. Postgres is the only source of truth (ARCHITECTURE
 *     §1); if `SELECT 1` fails or times out the instance cannot serve → `fail` →
 *     `ok:false` → 503.
 *   - queue depth / email sync lag — NON-critical. A deep queue or a lagging
 *     mailbox means work is backing up, not that the process is dead. Killing a
 *     healthy-but-backlogged instance makes the backlog worse, so these breach
 *     to `warn` and the probe stays 200. Alerts (see alerts.ts) are what page on
 *     them. A queue introspection error is also only a `warn` — the queue is a
 *     wake-up hint (ARCHITECTURE §4), never authoritative.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DatabaseCheck {
  status: CheckStatus; // 'pass' | 'fail'
  latencyMs?: number;
  error?: string;
}

export interface QueueCheck {
  status: CheckStatus; // 'pass' | 'warn'
  depth: number | null;
  threshold?: number;
  error?: string;
}

export interface SyncLagCheck {
  status: CheckStatus; // 'pass' | 'warn'
  lagSeconds: number | null;
  liveAccounts: number;
  accountsWithEvents: number;
  threshold?: number;
  error?: string;
}

export interface HealthReport {
  ok: boolean;
  checks: {
    database: DatabaseCheck;
    queue: QueueCheck;
    emailSyncLag: SyncLagCheck;
  };
  version: string;
}

/** Degraded thresholds, shared with the alert emitter (alerts.ts imports this). */
export interface HealthThresholds {
  /** Queue depth above which the queue check degrades / an alert fires. */
  queueDepth?: number;
  /** Email sync lag (seconds) above which the sync-lag check degrades / alerts. */
  syncLagSeconds?: number;
}

/**
 * Queue-depth introspection seam. The queue code stays untouched (DECISIONS
 * D-013 keeps the driver minimal); the composition root adapts whatever driver
 * is live into this shape — e.g. `{ depth: () => inProcess.pendingCount }` or
 * `{ depth: async () => bull.getWaitingCount() }`.
 */
export interface QueueDepthProbe {
  depth(): Promise<number> | number;
}

const DEFAULT_DB_TIMEOUT_MS = 2000;
const DEFAULT_QUERY_TIMEOUT_MS = 2000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Race a promise against a deadline. On timeout the returned promise rejects; a
 * late settlement of the original is swallowed (handlers are attached), so there
 * is no unhandled rejection even though the underlying query cannot be canceled.
 */
function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface DbCheckOptions {
  now?: () => number;
  timeoutMs?: number;
}

/** `SELECT 1` with a timeout. `fail` (never throws) on error/timeout. */
export async function checkDatabase(db: Db, options: DbCheckOptions = {}): Promise<DatabaseCheck> {
  const now = options.now ?? ((): number => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_DB_TIMEOUT_MS;
  const start = now();
  try {
    await withTimeout(
      Promise.resolve(db.execute(sql`select 1`)),
      timeoutMs,
      'database check timed out',
    );
    return { status: 'pass', latencyMs: Math.max(0, Math.round(now() - start)) };
  } catch (err) {
    return { status: 'fail', error: errorMessage(err) };
  }
}

/** Queue depth via the injected probe. `warn` (never fail) on breach or error. */
export async function checkQueueDepth(
  probe: QueueDepthProbe | undefined,
  threshold: number | undefined,
): Promise<QueueCheck> {
  if (probe === undefined) return { status: 'pass', depth: null };
  try {
    const depth = await probe.depth();
    const breached = threshold !== undefined && depth > threshold;
    return {
      status: breached ? 'warn' : 'pass',
      depth,
      ...(threshold !== undefined ? { threshold } : {}),
    };
  } catch (err) {
    return { status: 'warn', depth: null, error: errorMessage(err) };
  }
}

interface SyncLagRow {
  live_count: number | string;
  with_events: number | string;
  oldest_epoch: number | string | null;
}

export interface SyncLagCheckOptions {
  now?: () => number;
  thresholdSeconds?: number;
  timeoutMs?: number;
}

/**
 * Email sync lag: the max age of the last `sync_events` row across accounts
 * currently in `LIVE`. Accounts not in LIVE are excluded; LIVE accounts with no
 * events yet contribute to `liveAccounts` but not to the age (there is no "last
 * row" to measure). `warn` (never fail) on breach, query error, or timeout.
 */
export async function checkSyncLag(
  db: Db,
  options: SyncLagCheckOptions = {},
): Promise<SyncLagCheck> {
  const now = options.now ?? ((): number => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const threshold = options.thresholdSeconds;
  try {
    const result = await withTimeout(
      Promise.resolve(
        db.execute(sql`
          WITH live AS (
            SELECT ea.id AS account_id, max(se.at) AS last_at
            FROM email_accounts ea
            LEFT JOIN sync_events se ON se.account_id = ea.id
            WHERE ea.sync_status = 'LIVE'
            GROUP BY ea.id
          )
          SELECT
            count(*)::int AS live_count,
            count(last_at)::int AS with_events,
            extract(epoch FROM min(last_at)) AS oldest_epoch
          FROM live
        `),
      ),
      timeoutMs,
      'sync-lag check timed out',
    );
    const row = (result as { rows: SyncLagRow[] }).rows[0];
    const liveAccounts = row !== undefined ? Number(row.live_count) : 0;
    const accountsWithEvents = row !== undefined ? Number(row.with_events) : 0;
    const oldestEpoch =
      row !== undefined && row.oldest_epoch !== null ? Number(row.oldest_epoch) : null;
    const lagSeconds =
      oldestEpoch !== null ? Math.max(0, Math.round(now() / 1000 - oldestEpoch)) : null;
    const breached = lagSeconds !== null && threshold !== undefined && lagSeconds > threshold;
    return {
      status: breached ? 'warn' : 'pass',
      lagSeconds,
      liveAccounts,
      accountsWithEvents,
      ...(threshold !== undefined ? { threshold } : {}),
    };
  } catch (err) {
    return {
      status: 'warn',
      lagSeconds: null,
      liveAccounts: 0,
      accountsWithEvents: 0,
      error: errorMessage(err),
    };
  }
}

export interface HealthDeps {
  db: Db;
  /** Queue-depth introspection seam (adapter around the live QueueDriver). */
  queueDepth?: QueueDepthProbe;
  /** Deploy version for the `version` field; falls back to `APP_VERSION`/`unknown`. */
  version?: string;
  /** Injected clock (ms) for latency + lag math. */
  now?: () => number;
  /** Degrade thresholds for queue depth + sync lag. */
  thresholds?: HealthThresholds;
  dbTimeoutMs?: number;
  syncLagTimeoutMs?: number;
}

function resolveVersion(injected: string | undefined): string {
  return injected ?? process.env['APP_VERSION'] ?? 'unknown';
}

/** Run all three checks (in parallel) and compose the report + liveness verdict. */
export async function gatherHealth(deps: HealthDeps): Promise<HealthReport> {
  const now = deps.now ?? ((): number => Date.now());
  const [database, queue, emailSyncLag] = await Promise.all([
    checkDatabase(deps.db, {
      now,
      ...(deps.dbTimeoutMs !== undefined ? { timeoutMs: deps.dbTimeoutMs } : {}),
    }),
    checkQueueDepth(deps.queueDepth, deps.thresholds?.queueDepth),
    checkSyncLag(deps.db, {
      now,
      ...(deps.thresholds?.syncLagSeconds !== undefined
        ? { thresholdSeconds: deps.thresholds.syncLagSeconds }
        : {}),
      ...(deps.syncLagTimeoutMs !== undefined ? { timeoutMs: deps.syncLagTimeoutMs } : {}),
    }),
  ]);
  // Only the critical (database) check gates liveness — degraded-not-dead.
  const ok = database.status !== 'fail';
  return { ok, checks: { database, queue, emailSyncLag }, version: resolveVersion(deps.version) };
}

/**
 * Register `GET /healthz`. Fastify's own logging config is irrelevant here; the
 * probe is deliberately unauthenticated and side-effect-free.
 */
export function registerHealthz(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/healthz', async (_request, reply) => {
    const report = await gatherHealth(deps);
    return reply.status(report.ok ? 200 : 503).send(report);
  });
}
