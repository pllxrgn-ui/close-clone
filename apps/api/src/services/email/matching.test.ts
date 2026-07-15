import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { emailThreads, type Db } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { decideMatch, findCandidateLeadIds, ParticipantLeadMatcher } from './matching.ts';
import {
  ingest,
  makeRaw,
  seedAccount,
  seedContact,
  seedLead,
  seedUser,
  softDeleteLead,
  threadsFor,
} from './test-helpers.ts';

/**
 * Thread → lead matching (task 2c, CONTRACTS §C5): participant email → contact →
 * lead. Exactly one candidate ⇒ matched; zero or many ⇒ ambiguous, NEVER guessed.
 */

const deps = { matcher: new ParticipantLeadMatcher() };
const ADDRESS = 'rep@mock.test';

let ctx: TestDb;
let accountId: string;

beforeEach(async () => {
  ctx = await createTestDb();
  const userId = await seedUser(ctx.db);
  accountId = await seedAccount(ctx.db, userId, ADDRESS);
}, 60_000);
afterEach(async () => {
  await ctx.close();
});

describe('decideMatch (never-guess rule)', () => {
  test('exactly one candidate → matched', () => {
    expect(decideMatch(['lead-1'])).toEqual({ triageStatus: 'matched', leadId: 'lead-1' });
  });
  test('zero candidates → ambiguous', () => {
    expect(decideMatch([])).toEqual({ triageStatus: 'ambiguous', leadId: null });
  });
  test('multiple candidates → ambiguous (no guess)', () => {
    expect(decideMatch(['lead-1', 'lead-2'])).toEqual({ triageStatus: 'ambiguous', leadId: null });
  });
});

describe('findCandidateLeadIds', () => {
  test('matches a contact email case-insensitively', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['Alice@Acme.COM']);
    expect(await findCandidateLeadIds(ctx.db, accountId, ['alice@acme.com'])).toEqual([lead]);
  });

  test('no contact match → empty', async () => {
    await seedLead(ctx.db, 'Acme');
    expect(await findCandidateLeadIds(ctx.db, accountId, ['stranger@nowhere.test'])).toEqual([]);
  });

  test('two leads owning the participants → both (sorted)', async () => {
    const l1 = await seedLead(ctx.db, 'Acme');
    const l2 = await seedLead(ctx.db, 'Beta');
    await seedContact(ctx.db, l1, ['a@ext.test']);
    await seedContact(ctx.db, l2, ['b@ext.test']);
    const got = await findCandidateLeadIds(ctx.db, accountId, ['a@ext.test', 'b@ext.test']);
    expect(got.sort()).toEqual([l1, l2].sort());
  });

  test("the mailbox's own address never matches a contact", async () => {
    const lead = await seedLead(ctx.db, 'Self');
    await seedContact(ctx.db, lead, [ADDRESS]); // a contact carrying the rep's own address
    expect(await findCandidateLeadIds(ctx.db, accountId, [ADDRESS])).toEqual([]);
  });

  test('soft-deleted contact is excluded', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test'], { deleted: true });
    expect(await findCandidateLeadIds(ctx.db, accountId, ['a@ext.test'])).toEqual([]);
  });

  test('soft-deleted lead is excluded', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    await softDeleteLead(ctx.db, lead);
    expect(await findCandidateLeadIds(ctx.db, accountId, ['a@ext.test'])).toEqual([]);
  });

  test('is idempotent / pure — same inputs, same result', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    const first = await findCandidateLeadIds(ctx.db, accountId, ['a@ext.test']);
    const second = await findCandidateLeadIds(ctx.db, accountId, ['a@ext.test']);
    expect(second).toEqual(first);
  });
});

describe('ingest → thread match', () => {
  test('single candidate lead → thread matched to it', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    await ingest(ctx.db, deps, accountId, makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Deal' }));
    const [thread] = await threadsFor(ctx.db, accountId);
    expect(thread!.triageStatus).toBe('matched');
    expect(thread!.leadId).toBe(lead);
  });

  test('no candidate → ambiguous, queued for triage', async () => {
    await ingest(ctx.db, deps, accountId, makeRaw({ rfcMessageId: '<a@x>', from: 'stranger@nowhere.test' }));
    const [thread] = await threadsFor(ctx.db, accountId);
    expect(thread!.triageStatus).toBe('ambiguous');
    expect(thread!.leadId).toBeNull();
  });

  test('two candidate leads → ambiguous (never guessed)', async () => {
    const l1 = await seedLead(ctx.db, 'Acme');
    const l2 = await seedLead(ctx.db, 'Beta');
    await seedContact(ctx.db, l1, ['a@ext.test']);
    await seedContact(ctx.db, l2, ['b@ext.test']);
    // A single message whose from+cc reach both leads' contacts.
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', cc: ['b@ext.test'], subject: 'Multi' }),
    );
    const [thread] = await threadsFor(ctx.db, accountId);
    expect(thread!.triageStatus).toBe('ambiguous');
    expect(thread!.leadId).toBeNull();
  });

  test('re-ingesting the same message changes nothing (idempotent match)', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    const raw = makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Deal' });
    await ingest(ctx.db, deps, accountId, raw);
    const before = await threadsFor(ctx.db, accountId);
    await ingest(ctx.db, deps, accountId, raw);
    await ingest(ctx.db, deps, accountId, raw);
    const after = await threadsFor(ctx.db, accountId);
    expect(after).toEqual(before);
  });
});

describe('latch (protects human decisions + written activities)', () => {
  test('a matched thread stays matched even after a second lead’s contact joins it', async () => {
    const l1 = await seedLead(ctx.db, 'Acme');
    const l2 = await seedLead(ctx.db, 'Beta');
    await seedContact(ctx.db, l1, ['a@ext.test']);
    await seedContact(ctx.db, l2, ['b@ext.test']);
    // A resolves to exactly L1 → matched L1.
    await ingest(ctx.db, deps, accountId, makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Deal' }));
    // B links into the same thread and would introduce L2 — but the latch holds.
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<b@x>', from: 'b@ext.test', subject: 'Re: Deal', references: ['<a@x>'] }),
    );
    const threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.triageStatus).toBe('matched');
    expect(threads[0]!.leadId).toBe(l1);
  });

  test('an ignored thread is never auto-matched by a later message', async () => {
    // First message: unknown sender → ambiguous thread.
    await ingest(ctx.db, deps, accountId, makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Intro' }));
    const [amb] = await threadsFor(ctx.db, accountId);
    await ctx.db
      .update(emailThreads)
      .set({ triageStatus: 'ignored' })
      .where(eq(emailThreads.id, amb!.id));
    // Now a contact exists for that sender, and a sibling message joins the thread.
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    await ingest(ctx.db, deps, accountId, makeRaw({ rfcMessageId: '<b@x>', from: 'a@ext.test', subject: 'Re: Intro' }));
    const threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.triageStatus).toBe('ignored'); // stays ignored, not auto-matched
    expect(threads[0]!.leadId).toBeNull();
  });

  test('an ambiguous thread promotes to matched once a single lead resolves', async () => {
    // Message from an unknown sender → ambiguous.
    await ingest(ctx.db, deps, accountId, makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Intro' }));
    expect((await threadsFor(ctx.db, accountId))[0]!.triageStatus).toBe('ambiguous');
    // The contact is created; a sibling message joins the thread and resolves L1.
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    await ingest(ctx.db, deps, accountId, makeRaw({ rfcMessageId: '<b@x>', from: 'a@ext.test', subject: 'Re: Intro' }));
    const threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.triageStatus).toBe('matched');
    expect(threads[0]!.leadId).toBe(lead);
  });
});

// Guard the transaction-executor contract: the matcher reads contacts on the same
// handle it is given (so it participates in the ingest transaction, I-SYNC).
test('ParticipantLeadMatcher.match runs on the injected executor', async () => {
  const lead = await seedLead(ctx.db, 'Acme');
  await seedContact(ctx.db, lead, ['a@ext.test']);
  const matcher = new ParticipantLeadMatcher();
  const run = (exec: Db) => matcher.match(exec, { accountId, participants: ['a@ext.test'] });
  await expect(run(ctx.db)).resolves.toEqual({ triageStatus: 'matched', leadId: lead });
});
