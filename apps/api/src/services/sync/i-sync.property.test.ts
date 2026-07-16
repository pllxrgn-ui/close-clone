import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { IncomingEmail } from '@switchboard/shared/providers';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { MockEmailProvider } from '../../providers/mock/mock-email-provider.ts';
import { runBackfill } from './backfill.ts';
import { incrementalPull } from './incremental.ts';
import type { SyncEngineDeps } from './engine-deps.ts';
import {
  canonicalDump,
  makeCipher,
  makeEngine,
  seedAccount,
  seedUser,
  type CanonicalDump,
} from './test-support.ts';

/**
 * Task 2f — the ADVERSARIAL interleaving property suite for CONTRACTS §C5 I-SYNC:
 * for ANY interleaving/replay/reordering of {backfill pages, webhook-driven pulls,
 * duplicated pushes, history-expiry resyncs, idle sweeps}, the final DB state
 * (email_messages, email_threads, activities) is byte-identical to one clean pass.
 *
 * `i-sync.test.ts` hand-writes five interleavings and asserts each equals the clean
 * baseline. This file GENERALIZES that: a deterministic seeded generator draws a
 * random-but-valid drive plan over the SAME fixed external mailbox truth (identical
 * message identity, history ids, threads) and asserts every plan's canonical dump
 * deep-equals the baseline, across a bank of seeds. Because the external truth is
 * fixed, provider-assigned ids are stable, so byte-identity is the right oracle;
 * only WHEN/HOW-OFTEN backfill and pulls run varies.
 *
 * Attacks folded in per plan: variable backfill/push split (message present at
 * backfill vs arriving by push — the dedupe backstop), duplicated webhook
 * deliveries (the same history pulled 1–3×), batched vs one-at-a-time push drains
 * (page reordering at the cursor), and a history expiry mid-stream that forces the
 * RESYNC dedupe re-backfill. All are no-ops by construction — this proves it.
 */

const ADDRESS = 'rep@mock.test';

interface Msg {
  rfc: string;
  thread: string;
  from: string;
  subject: string;
  historyId: number;
}

// M2 replies into M1's thread (t-1); the rest are their own threads. Identical to
// i-sync.test.ts so the two suites certify the same external truth.
const MSGS: readonly Msg[] = [
  { rfc: '<m1@ext>', thread: 't-1', from: 'a@ext.test', subject: 'Intro', historyId: 10 },
  { rfc: '<m2@ext>', thread: 't-1', from: 'a@ext.test', subject: 'Re: Intro', historyId: 20 },
  { rfc: '<m3@ext>', thread: 't-3', from: 'b@ext.test', subject: 'Quote', historyId: 30 },
  { rfc: '<m4@ext>', thread: 't-4', from: 'c@ext.test', subject: 'Demo', historyId: 40 },
  { rfc: '<m5@ext>', thread: 't-5', from: 'd@ext.test', subject: 'Pricing', historyId: 50 },
  { rfc: '<m6@ext>', thread: 't-6', from: 'e@ext.test', subject: 'Follow up', historyId: 60 },
  { rfc: '<m7@ext>', thread: 't-7', from: 'f@ext.test', subject: 'Ping', historyId: 70 },
  { rfc: '<m8@ext>', thread: 't-8', from: 'g@ext.test', subject: 'Renewal', historyId: 80 },
];

// A multi-seed loop over full backfill/pull drives; give the file a contention-proof
// budget so the fully-parallel repo suite cannot starve it past the 5s default.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function inject(provider: MockEmailProvider, m: Msg): void {
  const email: IncomingEmail = {
    from: m.from,
    subject: m.subject,
    rfcMessageId: m.rfc,
    threadId: m.thread,
    bodyText: `body of ${m.rfc}`,
  };
  provider.injectIncoming(email, m.historyId);
}

// --- Deterministic seeded PRNG (xmur3 + mulberry32; inlined, see the sequence
// suite for why we do not depend on the DB-free @switchboard/fixtures Rng). -----

function makeRng(seed: string): {
  int: (min: number, max: number) => number;
  chance: (n: number) => boolean;
} {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^ (h >>> 16)) >>> 0;
  const next01 = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (min, max) => min + Math.floor(next01() * (max - min + 1)),
    chance: (n) => next01() < n,
  };
}

let ctx: TestDb;

async function newAccount(
  label: string,
): Promise<{ provider: MockEmailProvider; engine: SyncEngineDeps; accountId: string }> {
  // Small page sizes force multi-page backfill AND multi-page history walks, so the
  // per-page checkpoint/cursor transactions are exercised under every plan.
  const provider = new MockEmailProvider({
    address: ADDRESS,
    backfillPageSize: 2,
    historyPageSize: 2,
  });
  const userId = await seedUser(ctx.db, `${label}@example.com`);
  const encrypted = makeCipher().encrypt(provider.mintTokens());
  const accountId = await seedAccount(ctx.db, {
    userId,
    address: ADDRESS,
    syncStatus: 'BACKFILLING',
    encryptedTokens: encrypted,
  });
  const engine = makeEngine(ctx.db, provider);
  return { provider, engine, accountId };
}

// Clean baseline: first 4 present at link time (backfilled), last 4 by push, each
// followed by one pull — identical to i-sync.test.ts's clean().
async function baseline(): Promise<CanonicalDump> {
  const { provider, engine, accountId } = await newAccount('baseline');
  for (let i = 0; i < 4; i += 1) inject(provider, MSGS[i]!);
  await runBackfill(engine, accountId);
  for (let i = 4; i < 8; i += 1) {
    inject(provider, MSGS[i]!);
    await incrementalPull(engine, accountId);
  }
  return canonicalDump(ctx.db, accountId);
}

/**
 * Draw and execute one random-but-valid drive plan over the fixed 8-message truth.
 * Messages are always injected in id order (so provider ids stay stable); only the
 * backfill/push split, batching, replay count, and resync placement vary.
 */
async function drivePlan(seed: string): Promise<CanonicalDump> {
  const rng = makeRng(seed);
  const { provider, engine, accountId } = await newAccount(`plan-${seed}`);

  // 1. Split: k messages present before backfill (1..8). k=8 → pure backfill.
  const k = rng.int(1, 8);
  for (let i = 0; i < k; i += 1) inject(provider, MSGS[i]!);
  await runBackfill(engine, accountId);

  // 2. Push phase: inject the rest in randomized batches, drain with replayed pulls,
  //    occasionally expiring history to force a RESYNC re-backfill mid-stream.
  let next = k;
  while (next < 8) {
    const remaining = 8 - next;
    const batch = rng.int(1, remaining);
    for (let j = 0; j < batch; j += 1) {
      inject(provider, MSGS[next]!);
      next += 1;
    }
    // Duplicated webhook deliveries: pull the same history 1–3 times (replay).
    const pulls = rng.int(1, 3);
    for (let t = 0; t < pulls; t += 1) {
      // A ~30% chance to expire history just below the head first, sending the very
      // next pull down the RESYNC dedupe-backfill path instead of a history walk.
      if (rng.chance(0.3)) provider.expireHistoryBefore(MSGS[next - 1]!.historyId + 1);
      await incrementalPull(engine, accountId);
    }
  }

  // 3. Terminal drains: idle replays (and a possible final expiry) must not perturb
  //    the settled state — replay safety by construction.
  if (rng.chance(0.5)) provider.expireHistoryBefore(MSGS[7]!.historyId + 1);
  await incrementalPull(engine, accountId);
  await incrementalPull(engine, accountId);

  return canonicalDump(ctx.db, accountId);
}

beforeAll(async () => {
  ctx = await createTestDb();
}, 120_000);
afterAll(async () => {
  await ctx.close();
});

describe('I-SYNC: byte-identical final state under randomized interleavings', () => {
  test('every seeded drive plan matches the clean baseline', async () => {
    const base = await baseline();
    // Sanity: the baseline captured all 8 messages across 7 threads (t-1 shared).
    expect(base.messages).toHaveLength(8);
    expect(base.threads).toHaveLength(7);

    const SEEDS = 32;
    for (let s = 0; s < SEEDS; s += 1) {
      const dump = await drivePlan(`isync-${s}`);
      expect(dump, `plan isync-${s} must equal the clean baseline`).toEqual(base);
    }
  }, 120_000);
});
