import { describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import type { IncomingEmail } from '@switchboard/shared/providers';
import type { Db } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { MockEmailProvider } from '../../providers/mock/mock-email-provider.ts';
import { runBackfill } from '../sync/backfill.ts';
import { incrementalPull } from '../sync/incremental.ts';
import type { SyncEngineDeps } from '../sync/engine-deps.ts';
import { makeCipher, makeEngine, seedAccount, seedUser } from '../sync/test-support.ts';
import { ParticipantLeadMatcher } from './matching.ts';
import { seedContact, seedLead } from './test-helpers.ts';

/**
 * I-SYNC WITH real matching (task 2c acceptance + CONTRACTS §C5): the base I-SYNC
 * suite runs the ambiguous null-matcher (0 activities). This one seeds a contact
 * so every message resolves to a single lead — exercising matching AND the
 * `email_received` materialization — and asserts the final DB (threads, messages,
 * activities) is byte-identical to a single clean pass across replays, batching,
 * and push-during-backfill. Re-matching already-matched data changes nothing.
 */

const ADDRESS = 'rep@mock.test';
const CONTACT = 'a@ext.test';

interface Msg {
  rfc: string;
  thread: string;
  subject: string;
  historyId: number;
}

// All four are from the same external contact (→ single-lead match). m2 replies
// into m1's thread by subject+participant fallback; m3/m4 are their own threads.
const MSGS: readonly Msg[] = [
  { rfc: '<m1@ext>', thread: 't-1', subject: 'Intro', historyId: 10 },
  { rfc: '<m2@ext>', thread: 't-1', subject: 'Re: Intro', historyId: 20 },
  { rfc: '<m3@ext>', thread: 't-3', subject: 'Pricing', historyId: 30 },
  { rfc: '<m4@ext>', thread: 't-4', subject: 'Demo', historyId: 40 },
];

function inject(p: MockEmailProvider, m: Msg): void {
  const email: IncomingEmail = {
    from: CONTACT,
    subject: m.subject,
    rfcMessageId: m.rfc,
    threadId: m.thread,
    sentAt: new Date(Date.UTC(2026, 3, 1, 0, 0, m.historyId)).toISOString(),
    bodyText: `body of ${m.rfc}`,
  };
  p.injectIncoming(email, m.historyId);
}

interface Dump {
  threads: unknown[];
  messages: unknown[];
  activities: unknown[];
}

/** uuid-independent dump: threads/messages keyed by provider/rfc id, activities
 *  mapped back to their message's rfc id and the single lead as a boolean. */
async function dump(db: Db, accountId: string, leadId: string): Promise<Dump> {
  const threads = await db.execute(sql`
    SELECT t.provider_thread_id AS ptid, t.subject_norm AS sn, t.participants AS parts,
           t.triage_status AS ts, (t.lead_id = ${leadId}) AS matched_to_lead
    FROM email_threads t
    WHERE EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id AND m.account_id = ${accountId})
    ORDER BY t.provider_thread_id ASC
  `);
  const messages = await db.execute(sql`
    SELECT m.rfc_message_id AS rfc, m.direction AS dir, m.subject AS subj, t.provider_thread_id AS tptid
    FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
    WHERE m.account_id = ${accountId}
    ORDER BY m.rfc_message_id ASC
  `);
  const activities = await db.execute(sql`
    SELECT a.type AS type, a.occurred_at AS occ, m.rfc_message_id AS rfc
    FROM activities a JOIN email_messages m ON m.id = (a.payload->>'emailMessageId')::uuid
    WHERE a.lead_id = ${leadId}
    ORDER BY a.occurred_at ASC, m.rfc_message_id ASC
  `);
  const rows = (r: unknown): unknown[] => (r as { rows: unknown[] }).rows;
  return { threads: rows(threads), messages: rows(messages), activities: rows(activities) };
}

type Scenario = (p: MockEmailProvider, e: SyncEngineDeps, id: string) => Promise<void>;

/**
 * Each scenario runs in its OWN clean-room DB (unlike the base ambiguous I-SYNC
 * suite, which can share one DB because it seeds no contacts). Here every scenario
 * seeds a contact for the same address, so a shared DB would make that address
 * resolve to several leads — the dumps are canonicalized to be uuid-independent,
 * so per-DB isolation is exactly the single-clean-pass comparison C5 asks for.
 */
async function runScenario(scenario: Scenario): Promise<Dump> {
  const ctx: TestDb = await createTestDb();
  try {
    const provider = new MockEmailProvider({ address: ADDRESS, backfillPageSize: 2, historyPageSize: 2 });
    const userId = await seedUser(ctx.db, `${scenario.name || 'anon'}@example.com`);
    const leadId = await seedLead(ctx.db, `Lead-${scenario.name}`);
    await seedContact(ctx.db, leadId, [CONTACT]);
    const encrypted = makeCipher().encrypt(provider.mintTokens());
    const accountId = await seedAccount(ctx.db, {
      userId,
      address: ADDRESS,
      syncStatus: 'BACKFILLING',
      encryptedTokens: encrypted,
    });
    const engine = makeEngine(ctx.db, provider, new ParticipantLeadMatcher());
    await scenario(provider, engine, accountId);
    return await dump(ctx.db, accountId, leadId);
  } finally {
    await ctx.close();
  }
}

async function clean(p: MockEmailProvider, e: SyncEngineDeps, id: string): Promise<void> {
  inject(p, MSGS[0]!);
  inject(p, MSGS[1]!);
  await runBackfill(e, id);
  inject(p, MSGS[2]!);
  await incrementalPull(e, id);
  inject(p, MSGS[3]!);
  await incrementalPull(e, id);
}

async function replayHeavy(p: MockEmailProvider, e: SyncEngineDeps, id: string): Promise<void> {
  inject(p, MSGS[0]!);
  inject(p, MSGS[1]!);
  await runBackfill(e, id);
  for (let i = 2; i < 4; i += 1) {
    inject(p, MSGS[i]!);
    await incrementalPull(e, id);
    await incrementalPull(e, id);
    await incrementalPull(e, id);
  }
  await incrementalPull(e, id);
}

async function batched(p: MockEmailProvider, e: SyncEngineDeps, id: string): Promise<void> {
  inject(p, MSGS[0]!);
  inject(p, MSGS[1]!);
  await runBackfill(e, id);
  inject(p, MSGS[2]!);
  inject(p, MSGS[3]!);
  await incrementalPull(e, id);
}

async function pushDuringBackfill(p: MockEmailProvider, e: SyncEngineDeps, id: string): Promise<void> {
  inject(p, MSGS[0]!);
  inject(p, MSGS[1]!);
  inject(p, MSGS[2]!); // present before backfill
  await runBackfill(e, id);
  inject(p, MSGS[3]!);
  await incrementalPull(e, id);
  await incrementalPull(e, id); // idle sweep
}

describe('I-SYNC with real matching: activities are exactly-once and order-independent', () => {
  // Heavy: four scenarios, each spinning its own freshly-migrated PGlite DB, run
  // under the documented multi-agent CPU contention (DECISIONS D-017). Generous
  // timeout so setup cost never masquerades as a correctness failure.
  test('every interleaving reproduces the clean matched baseline', async () => {
    const baseline = await runScenario(clean);

    // The baseline actually matched (not silently ambiguous): 3 threads, all
    // matched to the lead, and one email_received per message.
    expect(baseline.threads).toHaveLength(3);
    expect(baseline.threads.every((t) => (t as { matched_to_lead: boolean }).matched_to_lead)).toBe(true);
    expect(baseline.activities).toHaveLength(4);
    expect(baseline.activities.every((a) => (a as { type: string }).type === 'email_received')).toBe(true);

    for (const scenario of [replayHeavy, batched, pushDuringBackfill]) {
      const got = await runScenario(scenario);
      expect(got, `scenario ${scenario.name} must match the clean matched baseline`).toEqual(baseline);
    }
  }, 120_000);
});
