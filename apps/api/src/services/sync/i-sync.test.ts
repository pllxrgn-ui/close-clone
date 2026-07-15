import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
 * I-SYNC invariant (CONTRACTS §C5): for ANY interleaving/replay/reordering of
 * {backfill pages, webhook-driven pulls, resyncs, worker restarts}, the final DB
 * (email_messages, email_threads, activities) is byte-identical to one clean
 * pass. Each scenario drives the same external mailbox truth through a different
 * engine call order; all canonical dumps must deep-equal the clean baseline.
 *
 * The mailbox truth is fixed: eight messages injected in the SAME order (so the
 * provider assigns identical ids) at fixed, strictly-increasing history ids —
 * two of them share a thread (reply) to exercise thread grouping under replay.
 * What varies between scenarios is only when/how often backfill and pulls run.
 */

const ADDRESS = 'rep@mock.test';

interface Msg {
  rfc: string;
  thread: string;
  from: string;
  subject: string;
  historyId: number;
}

// M2 replies into M1's thread (t-1); the rest are their own threads.
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

type Scenario = (
  provider: MockEmailProvider,
  engine: SyncEngineDeps,
  accountId: string,
) => Promise<void>;

let ctx: TestDb;

beforeEach(async () => {
  ctx = await createTestDb();
});
afterEach(async () => {
  await ctx.close();
});

async function runScenario(scenario: Scenario): Promise<CanonicalDump> {
  const provider = new MockEmailProvider({ address: ADDRESS, backfillPageSize: 2, historyPageSize: 2 });
  const userId = await seedUser(ctx.db, `${scenario.name || 'anon'}@example.com`);
  const encrypted = makeCipher().encrypt(provider.mintTokens());
  const accountId = await seedAccount(ctx.db, {
    userId,
    address: ADDRESS,
    syncStatus: 'BACKFILLING',
    encryptedTokens: encrypted,
  });
  const engine = makeEngine(ctx.db, provider);
  await scenario(provider, engine, accountId);
  return canonicalDump(ctx.db, accountId);
}

// Clean baseline: first 4 exist at link time (backfilled), last 4 arrive by push,
// each followed by exactly one pull.
async function clean(p: MockEmailProvider, e: SyncEngineDeps, id: string): Promise<void> {
  for (let i = 0; i < 4; i += 1) inject(p, MSGS[i]!);
  await runBackfill(e, id);
  for (let i = 4; i < 8; i += 1) {
    inject(p, MSGS[i]!);
    await incrementalPull(e, id);
  }
}

// Every pull replayed three times; an extra sweep at the end.
async function replayHeavy(p: MockEmailProvider, e: SyncEngineDeps, id: string): Promise<void> {
  for (let i = 0; i < 4; i += 1) inject(p, MSGS[i]!);
  await runBackfill(e, id);
  for (let i = 4; i < 8; i += 1) {
    inject(p, MSGS[i]!);
    await incrementalPull(e, id);
    await incrementalPull(e, id);
    await incrementalPull(e, id);
  }
  await incrementalPull(e, id);
}

// All four pushes land, then ONE pull drains them together.
async function batched(p: MockEmailProvider, e: SyncEngineDeps, id: string): Promise<void> {
  for (let i = 0; i < 4; i += 1) inject(p, MSGS[i]!);
  await runBackfill(e, id);
  for (let i = 4; i < 8; i += 1) inject(p, MSGS[i]!);
  await incrementalPull(e, id);
}

// Two of the "push" messages are already present at backfill time (they get
// imported by the backfill walk), the rest arrive by push.
async function pushDuringBackfill(
  p: MockEmailProvider,
  e: SyncEngineDeps,
  id: string,
): Promise<void> {
  for (let i = 0; i < 6; i += 1) inject(p, MSGS[i]!); // 6 present before backfill
  await runBackfill(e, id);
  for (let i = 6; i < 8; i += 1) {
    inject(p, MSGS[i]!);
    await incrementalPull(e, id);
  }
  await incrementalPull(e, id); // idle sweep
}

// A history expiry forces a RESYNC in the middle of the push phase.
async function withResync(p: MockEmailProvider, e: SyncEngineDeps, id: string): Promise<void> {
  for (let i = 0; i < 4; i += 1) inject(p, MSGS[i]!);
  await runBackfill(e, id);
  inject(p, MSGS[4]!);
  inject(p, MSGS[5]!);
  // Expire history so the next pull re-backfills (dedupe) instead of walking.
  p.expireHistoryBefore(81);
  await incrementalPull(e, id); // resync path
  for (let i = 6; i < 8; i += 1) {
    inject(p, MSGS[i]!);
    p.expireHistoryBefore(MSGS[i]!.historyId + 1);
    await incrementalPull(e, id);
  }
}

describe('I-SYNC: byte-identical final state under any interleaving', () => {
  test('all scenarios produce the clean baseline dump', async () => {
    const baseline = await runScenario(clean);

    // Sanity: the baseline actually captured all 8 messages across 8 threads
    // (t-1 shared by two messages ⇒ 7 distinct threads).
    expect(baseline.messages).toHaveLength(8);
    expect(baseline.threads).toHaveLength(7);
    expect(baseline.activities).toHaveLength(0); // matcher is ambiguous ⇒ no activities

    for (const scenario of [replayHeavy, batched, pushDuringBackfill, withResync]) {
      const dump = await runScenario(scenario);
      expect(dump, `scenario ${scenario.name} must match the clean baseline`).toEqual(baseline);
    }
  });
});
