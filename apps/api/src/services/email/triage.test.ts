import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AmbiguousLeadMatcher } from '../sync/matcher.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import {
  ActorNotAllowedError,
  InvalidTriageCursorError,
  ThreadNotFoundError,
  TriageConflictError,
  TriageLeadNotFoundError,
  ignoreThread,
  listAmbiguousThreads,
  resolveThreadToLead,
} from './triage.ts';
import {
  activitiesFor,
  auditFor,
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
 * Ambiguity triage queue (task 2c): list ambiguous threads, resolve to a lead
 * (materializing activities + audit), ignore. Audit-friendly (who/when),
 * RBAC-safe (active-user actor only), idempotent, and never a compliance bypass.
 */

const NIL = '00000000-0000-4000-8000-0000000000ff';
const deps = { matcher: new AmbiguousLeadMatcher() };

let ctx: TestDb;
let accountId: string;
let actor: string;

beforeEach(async () => {
  ctx = await createTestDb();
  const owner = await seedUser(ctx.db, { email: 'owner@example.com' });
  accountId = await seedAccount(ctx.db, owner);
  actor = await seedUser(ctx.db, { email: 'triager@example.com' });
}, 60_000);
afterEach(async () => {
  await ctx.close();
});

/** Ingest one ambiguous message (no contacts) and return its thread id. */
async function ambiguousThread(rfc: string, subject: string, from = 'x@ext.test'): Promise<string> {
  const res = await ingest(ctx.db, deps, accountId, makeRaw({ rfcMessageId: rfc, subject, from }));
  return res.threadId!;
}

describe('listAmbiguousThreads', () => {
  test('returns only ambiguous threads, with message count and candidate leads', async () => {
    // Ambiguous with two candidate leads (helps the human decide).
    const l1 = await seedLead(ctx.db, 'Acme');
    const l2 = await seedLead(ctx.db, 'Beta');
    await seedContact(ctx.db, l1, ['a@ext.test']);
    await seedContact(ctx.db, l2, ['b@ext.test']);
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<multi@x>', from: 'a@ext.test', cc: ['b@ext.test'], subject: 'Multi' }),
    );

    const page = await listAmbiguousThreads(ctx.db);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.messageCount).toBe(1);
    expect(page.items[0]!.candidateLeadIds.sort()).toEqual([l1, l2].sort());
    expect(page.nextCursor).toBeUndefined();
  });

  test('excludes matched and ignored threads', async () => {
    const t1 = await ambiguousThread('<a@x>', 'A');
    const t2 = await ambiguousThread('<b@x>', 'B');
    await ambiguousThread('<c@x>', 'C');
    const lead = await seedLead(ctx.db, 'Acme');

    await resolveThreadToLead(ctx.db, { threadId: t1, leadId: lead, actorId: actor });
    await ignoreThread(ctx.db, { threadId: t2, actorId: actor });

    const page = await listAmbiguousThreads(ctx.db);
    expect(page.items).toHaveLength(1); // only C remains ambiguous
  });

  test('paginates by keyset without dropping or repeating rows', async () => {
    await ambiguousThread('<a@x>', 'A');
    await ambiguousThread('<b@x>', 'B');
    await ambiguousThread('<c@x>', 'C');

    const first = await listAmbiguousThreads(ctx.db, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = await listAmbiguousThreads(ctx.db, { limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();

    const ids = [...first.items, ...second.items].map((i) => i.threadId);
    expect(new Set(ids).size).toBe(3); // all distinct, none repeated
  });

  test('a malformed cursor is rejected', async () => {
    await expect(listAmbiguousThreads(ctx.db, { cursor: 'not-a-cursor!!' })).rejects.toBeInstanceOf(
      InvalidTriageCursorError,
    );
  });
});

describe('resolveThreadToLead', () => {
  test('attaches the lead, materializes activities, and writes an audit row', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    const lead = await seedLead(ctx.db, 'Acme');

    const result = await resolveThreadToLead(ctx.db, {
      threadId: thread,
      leadId: lead,
      actorId: actor,
      reason: 'clearly Acme',
    });
    expect(result.triageStatus).toBe('matched');
    expect(result.activitiesWritten).toBe(1);
    expect(result.alreadyResolved).toBe(false);

    const [snap] = await threadsFor(ctx.db, accountId);
    expect(snap!.triageStatus).toBe('matched');
    expect(snap!.leadId).toBe(lead);
    expect(await activitiesFor(ctx.db, lead)).toHaveLength(1);

    const audit = await auditFor(ctx.db, thread);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('email_thread.resolved');
    expect(audit[0]!.actorId).toBe(actor);
    expect(audit[0]!.actorType).toBe('user');
    expect(typeof audit[0]!.at).toBe('string'); // "when"
  });

  test('re-resolving to the same lead is idempotent (no extra activity or audit)', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    const lead = await seedLead(ctx.db, 'Acme');
    await resolveThreadToLead(ctx.db, { threadId: thread, leadId: lead, actorId: actor });

    const again = await resolveThreadToLead(ctx.db, { threadId: thread, leadId: lead, actorId: actor });
    expect(again.alreadyResolved).toBe(true);
    expect(again.activitiesWritten).toBe(0);
    expect(await activitiesFor(ctx.db, lead)).toHaveLength(1);
    expect(await auditFor(ctx.db, thread)).toHaveLength(1); // no second audit row
  });

  test('resolving an ignored thread is a valid human override', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    await ignoreThread(ctx.db, { threadId: thread, actorId: actor });
    const lead = await seedLead(ctx.db, 'Acme');

    const result = await resolveThreadToLead(ctx.db, { threadId: thread, leadId: lead, actorId: actor });
    expect(result.triageStatus).toBe('matched');
    expect((await threadsFor(ctx.db, accountId))[0]!.leadId).toBe(lead);
  });

  describe('failure paths', () => {
    test('unknown thread → ThreadNotFoundError', async () => {
      const lead = await seedLead(ctx.db, 'Acme');
      await expect(
        resolveThreadToLead(ctx.db, { threadId: NIL, leadId: lead, actorId: actor }),
      ).rejects.toBeInstanceOf(ThreadNotFoundError);
    });

    test('unknown lead → TriageLeadNotFoundError, thread untouched', async () => {
      const thread = await ambiguousThread('<a@x>', 'Deal');
      await expect(
        resolveThreadToLead(ctx.db, { threadId: thread, leadId: NIL, actorId: actor }),
      ).rejects.toBeInstanceOf(TriageLeadNotFoundError);
      expect((await threadsFor(ctx.db, accountId))[0]!.triageStatus).toBe('ambiguous');
    });

    test('soft-deleted lead → TriageLeadNotFoundError', async () => {
      const thread = await ambiguousThread('<a@x>', 'Deal');
      const lead = await seedLead(ctx.db, 'Acme');
      await softDeleteLead(ctx.db, lead);
      await expect(
        resolveThreadToLead(ctx.db, { threadId: thread, leadId: lead, actorId: actor }),
      ).rejects.toBeInstanceOf(TriageLeadNotFoundError);
    });

    test('inactive actor → ActorNotAllowedError, and nothing is mutated', async () => {
      const thread = await ambiguousThread('<a@x>', 'Deal');
      const lead = await seedLead(ctx.db, 'Acme');
      const inactive = await seedUser(ctx.db, { email: 'ex@example.com', isActive: false });
      await expect(
        resolveThreadToLead(ctx.db, { threadId: thread, leadId: lead, actorId: inactive }),
      ).rejects.toBeInstanceOf(ActorNotAllowedError);
      expect((await threadsFor(ctx.db, accountId))[0]!.triageStatus).toBe('ambiguous');
      expect(await auditFor(ctx.db, thread)).toHaveLength(0);
      expect(await activitiesFor(ctx.db, lead)).toHaveLength(0);
    });

    test('unknown actor → ActorNotAllowedError', async () => {
      const thread = await ambiguousThread('<a@x>', 'Deal');
      const lead = await seedLead(ctx.db, 'Acme');
      await expect(
        resolveThreadToLead(ctx.db, { threadId: thread, leadId: lead, actorId: NIL }),
      ).rejects.toBeInstanceOf(ActorNotAllowedError);
    });

    test('re-pointing a matched thread to a different lead → TriageConflictError', async () => {
      const thread = await ambiguousThread('<a@x>', 'Deal');
      const l1 = await seedLead(ctx.db, 'Acme');
      const l2 = await seedLead(ctx.db, 'Beta');
      await resolveThreadToLead(ctx.db, { threadId: thread, leadId: l1, actorId: actor });
      await expect(
        resolveThreadToLead(ctx.db, { threadId: thread, leadId: l2, actorId: actor }),
      ).rejects.toBeInstanceOf(TriageConflictError);
      // Original match is preserved.
      expect((await threadsFor(ctx.db, accountId))[0]!.leadId).toBe(l1);
    });
  });
});

describe('ignoreThread', () => {
  test('marks an ambiguous thread ignored and audits it', async () => {
    const thread = await ambiguousThread('<a@x>', 'Spam');
    const result = await ignoreThread(ctx.db, { threadId: thread, actorId: actor, reason: 'newsletter' });
    expect(result.triageStatus).toBe('ignored');
    expect(result.alreadyIgnored).toBe(false);

    expect((await threadsFor(ctx.db, accountId))[0]!.triageStatus).toBe('ignored');
    const audit = await auditFor(ctx.db, thread);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('email_thread.ignored');
    expect(audit[0]!.actorId).toBe(actor);
  });

  test('re-ignoring is idempotent (no second audit row)', async () => {
    const thread = await ambiguousThread('<a@x>', 'Spam');
    await ignoreThread(ctx.db, { threadId: thread, actorId: actor });
    const again = await ignoreThread(ctx.db, { threadId: thread, actorId: actor });
    expect(again.alreadyIgnored).toBe(true);
    expect(await auditFor(ctx.db, thread)).toHaveLength(1);
  });

  test('ignoring a matched thread → TriageConflictError', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    const lead = await seedLead(ctx.db, 'Acme');
    await resolveThreadToLead(ctx.db, { threadId: thread, leadId: lead, actorId: actor });
    await expect(ignoreThread(ctx.db, { threadId: thread, actorId: actor })).rejects.toBeInstanceOf(
      TriageConflictError,
    );
  });

  test('unknown thread → ThreadNotFoundError', async () => {
    await expect(ignoreThread(ctx.db, { threadId: NIL, actorId: actor })).rejects.toBeInstanceOf(
      ThreadNotFoundError,
    );
  });

  test('inactive actor → ActorNotAllowedError, thread untouched', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    const inactive = await seedUser(ctx.db, { email: 'ex2@example.com', isActive: false });
    await expect(
      ignoreThread(ctx.db, { threadId: thread, actorId: inactive }),
    ).rejects.toBeInstanceOf(ActorNotAllowedError);
    expect((await threadsFor(ctx.db, accountId))[0]!.triageStatus).toBe('ambiguous');
  });
});
