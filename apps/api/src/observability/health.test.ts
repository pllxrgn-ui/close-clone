import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { emailAccounts, syncEvents, users, type Db } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import {
  checkDatabase,
  checkQueueDepth,
  checkSyncLag,
  gatherHealth,
  registerHealthz,
  type QueueDepthProbe,
} from './health.ts';

/**
 * Task 5e — /healthz checks. DB checks run on PGlite (DECISIONS D-003). Covers
 * the happy path AND every failure/timeout path, plus the degraded-not-dead
 * rule: a queue/sync-lag breach warns (200) but only a dead Postgres fails (503).
 */

const NOW_MS = Date.parse('2026-07-16T12:00:00.000Z');
const now = (): number => NOW_MS;
const iso = (offsetSeconds: number): string =>
  new Date(NOW_MS + offsetSeconds * 1000).toISOString();

const USER = '00000000-0000-4000-8000-0000000000e1';
const ACCT_LIVE_RECENT = '10000000-0000-4000-8000-000000000001';
const ACCT_LIVE_STALE = '10000000-0000-4000-8000-000000000002';
const ACCT_LIVE_NOEVENTS = '10000000-0000-4000-8000-000000000003';
const ACCT_DEGRADED = '10000000-0000-4000-8000-000000000004';

/** A db handle whose `execute` never settles — drives the timeout path. */
function hangingDb(): Db {
  return { execute: () => new Promise(() => {}) } as unknown as Db;
}
/** A db handle whose `execute` rejects — drives the query-error path. */
function failingDb(message: string): Db {
  return { execute: () => Promise.reject(new Error(message)) } as unknown as Db;
}

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);
  await ctx.db
    .insert(users)
    .values({ id: USER, email: 'e@x.test', name: 'E', role: 'rep', idpSubject: 'idp|e' });
});

afterAll(async () => {
  await ctx.close();
});

async function seedSyncFixture(): Promise<void> {
  await ctx.db.insert(emailAccounts).values([
    {
      id: ACCT_LIVE_RECENT,
      userId: USER,
      address: 'a@x.test',
      provider: 'mock',
      syncStatus: 'LIVE',
    },
    {
      id: ACCT_LIVE_STALE,
      userId: USER,
      address: 'b@x.test',
      provider: 'mock',
      syncStatus: 'LIVE',
    },
    {
      id: ACCT_LIVE_NOEVENTS,
      userId: USER,
      address: 'c@x.test',
      provider: 'mock',
      syncStatus: 'LIVE',
    },
    {
      id: ACCT_DEGRADED,
      userId: USER,
      address: 'd@x.test',
      provider: 'mock',
      syncStatus: 'DEGRADED',
    },
  ]);
  await ctx.db.insert(syncEvents).values([
    { accountId: ACCT_LIVE_RECENT, toState: 'LIVE', cause: 'live', at: iso(-60) },
    { accountId: ACCT_LIVE_STALE, toState: 'LIVE', cause: 'live', at: iso(-3600) },
    // A very old event on a NON-live account — must be excluded from the metric.
    { accountId: ACCT_DEGRADED, toState: 'DEGRADED', cause: 'err', at: iso(-999999) },
  ]);
}

describe('checkDatabase', () => {
  test('passes against a live Postgres and reports latency', async () => {
    const result = await checkDatabase(ctx.db, { now });
    expect(result.status).toBe('pass');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('fails (not throws) when the query errors', async () => {
    const result = await checkDatabase(failingDb('connection refused'));
    expect(result.status).toBe('fail');
    expect(result.error).toContain('connection refused');
  });

  test('fails with a timeout when the query hangs past the deadline', async () => {
    const result = await checkDatabase(hangingDb(), { timeoutMs: 20 });
    expect(result.status).toBe('fail');
    expect(result.error).toContain('timed out');
  });
});

describe('checkQueueDepth', () => {
  test('passes with a null depth when no probe is wired', async () => {
    const result = await checkQueueDepth(undefined, 100);
    expect(result).toEqual({ status: 'pass', depth: null });
  });

  test('passes when depth is at/under threshold', async () => {
    const probe: QueueDepthProbe = { depth: () => 5 };
    const result = await checkQueueDepth(probe, 100);
    expect(result.status).toBe('pass');
    expect(result.depth).toBe(5);
    expect(result.threshold).toBe(100);
  });

  test('warns (never fails) when depth is over threshold', async () => {
    const probe: QueueDepthProbe = { depth: async () => 150 };
    const result = await checkQueueDepth(probe, 100);
    expect(result.status).toBe('warn');
    expect(result.depth).toBe(150);
  });

  test('warns when the probe itself throws (queue is not liveness-critical)', async () => {
    const probe: QueueDepthProbe = {
      depth: () => {
        throw new Error('redis down');
      },
    };
    const result = await checkQueueDepth(probe, 100);
    expect(result.status).toBe('warn');
    expect(result.depth).toBeNull();
    expect(result.error).toContain('redis down');
  });
});

describe('checkSyncLag', () => {
  beforeAll(seedSyncFixture);

  test('reports max lag over LIVE accounts with events, excluding non-LIVE', async () => {
    const result = await checkSyncLag(ctx.db, { now, thresholdSeconds: 600 });
    // 3 LIVE accounts; 2 have events; the stale one is 3600s old → over 600 → warn.
    expect(result.liveAccounts).toBe(3);
    expect(result.accountsWithEvents).toBe(2);
    expect(result.lagSeconds).toBe(3600);
    expect(result.status).toBe('warn');
    expect(result.threshold).toBe(600);
  });

  test('passes when the max lag is under threshold', async () => {
    const result = await checkSyncLag(ctx.db, { now, thresholdSeconds: 5000 });
    expect(result.status).toBe('pass');
    expect(result.lagSeconds).toBe(3600);
  });

  test('warns (not fails) when the query errors', async () => {
    const result = await checkSyncLag(failingDb('boom'), { now, thresholdSeconds: 600 });
    expect(result.status).toBe('warn');
    expect(result.lagSeconds).toBeNull();
    expect(result.error).toContain('boom');
  });

  test('fails soft with a timeout when the query hangs', async () => {
    const result = await checkSyncLag(hangingDb(), { now, timeoutMs: 20 });
    expect(result.status).toBe('warn');
    expect(result.error).toContain('timed out');
  });
});

describe('checkSyncLag — empty', () => {
  test('passes with null lag when there are no LIVE accounts', async () => {
    const fresh = await createTestDb();
    try {
      const result = await checkSyncLag(fresh.db, { now, thresholdSeconds: 600 });
      expect(result.status).toBe('pass');
      expect(result.lagSeconds).toBeNull();
      expect(result.liveAccounts).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});

describe('gatherHealth (degraded-not-dead)', () => {
  test('stays ok=true (200-worthy) when only queue/sync are degraded', async () => {
    const report = await gatherHealth({
      db: ctx.db,
      now,
      version: 'test-1',
      queueDepth: { depth: () => 9999 },
      thresholds: { queueDepth: 100, syncLagSeconds: 600 },
    });
    expect(report.ok).toBe(true); // db is alive → not dead
    expect(report.checks.database.status).toBe('pass');
    expect(report.checks.queue.status).toBe('warn');
    expect(report.checks.emailSyncLag.status).toBe('warn');
    expect(report.version).toBe('test-1');
  });

  test('is ok=false only when the database check fails', async () => {
    const report = await gatherHealth({ db: failingDb('db gone'), now, version: 'test-1' });
    expect(report.ok).toBe(false);
    expect(report.checks.database.status).toBe('fail');
  });
});

describe('registerHealthz plugin', () => {
  let app: FastifyInstance;
  afterAll(async () => {
    await app.close();
  });

  test('returns 200 with the full report when healthy', async () => {
    app = Fastify({ logger: false });
    registerHealthz(app, { db: ctx.db, now, version: 'v-200' });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; checks: Record<string, unknown>; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('v-200');
    expect(Object.keys(body.checks).sort()).toEqual(['database', 'emailSyncLag', 'queue']);
  });

  test('returns 503 when Postgres is unreachable', async () => {
    const down = Fastify({ logger: false });
    registerHealthz(down, { db: failingDb('down'), now, version: 'v-503' });
    const res = await down.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { ok: boolean }).ok).toBe(false);
    await down.close();
  });
});
