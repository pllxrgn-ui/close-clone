import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  activities,
  auditLog,
  calls,
  contacts,
  emailThreads,
  leads,
  leadStatuses,
  notes,
  opportunities,
  sendIntents,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  smsMessages,
  tasks,
  users,
} from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { runCli } from './index.ts';
import {
  hardDeleteLead,
  HardDeleteLeadNotFoundError,
  HardDeleteReasonRequiredError,
  OpenEnrollmentsError,
} from './hard-delete.ts';
import { mergeLeads, MergeLeadNotFoundError, SameLeadError } from './merge.ts';
import { userLookup } from './user-lookup.ts';

/**
 * Task 5g — the admin CLI commands, smoke-tested end-to-end against PGlite via an
 * injected db handle. Covers user-lookup counts, merge re-parenting + email
 * dedupe + enrollment-collision resolution + timeline/denorm/audit invariants,
 * hard-delete FK-ordered graph removal with a complete audit trail and refusals,
 * and CLI exit codes.
 */

let ctx: TestDb;
let dims: { userId: string; statusId: string; sequenceId: string; stepId: string };

const T0 = '2026-01-01T00:00:00.000Z';

async function seedDims(): Promise<typeof dims> {
  const [u] = await ctx.db
    .insert(users)
    .values({ email: 'rep@x.test', name: 'Rep One', role: 'rep', idpSubject: 'idp|rep' })
    .returning({ id: users.id });
  const [s] = await ctx.db
    .insert(leadStatuses)
    .values({ label: 'Potential', sortOrder: 0 })
    .returning({ id: leadStatuses.id });
  const [seq] = await ctx.db
    .insert(sequences)
    .values({ name: 'Outreach', status: 'active' })
    .returning({ id: sequences.id });
  const [step] = await ctx.db
    .insert(sequenceSteps)
    .values({ sequenceId: seq?.id ?? '', sortOrder: 0, type: 'email', delayHours: 0 })
    .returning({ id: sequenceSteps.id });
  return {
    userId: u?.id ?? '',
    statusId: s?.id ?? '',
    sequenceId: seq?.id ?? '',
    stepId: step?.id ?? '',
  };
}

async function seedLead(name: string, denorm?: Partial<typeof leads.$inferInsert>): Promise<string> {
  const [row] = await ctx.db
    .insert(leads)
    .values({ name, ownerId: dims.userId, statusId: dims.statusId, ...denorm })
    .returning({ id: leads.id });
  return row?.id ?? '';
}

async function seedContact(leadId: string, email: string): Promise<string> {
  const [row] = await ctx.db
    .insert(contacts)
    .values({ leadId, name: `Contact ${email}`, emails: [{ email, type: 'work' }], phones: [] })
    .returning({ id: contacts.id });
  return row?.id ?? '';
}

async function count(db: TestDb['db'], table: PgTable, col: PgColumn, value: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(col, value));
  return row?.n ?? 0;
}

beforeEach(async () => {
  ctx = await createTestDb();
  dims = await seedDims();
});
afterEach(async () => {
  await ctx.close();
});

describe('user-lookup', () => {
  test('resolves by email with activity counts', async () => {
    const leadId = await seedLead('Owned Co');
    await ctx.db
      .insert(activities)
      .values({ leadId, userId: dims.userId, type: 'note_added', occurredAt: T0 });
    await ctx.db
      .insert(tasks)
      .values({ leadId, assigneeId: dims.userId, title: 'Follow up', dueAt: T0 });

    const results = await userLookup(ctx.db, 'rep@x.test');
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(dims.userId);
    expect(results[0]?.counts.leadsOwned).toBe(1);
    expect(results[0]?.counts.activities).toBe(1);
    expect(results[0]?.counts.tasksAssigned).toBe(1);
  });

  test('resolves by name substring (case-insensitive)', async () => {
    const results = await userLookup(ctx.db, 'rep one');
    expect(results).toHaveLength(1);
    expect(results[0]?.email).toBe('rep@x.test');
  });

  test('no match → empty list', async () => {
    expect(await userLookup(ctx.db, 'ghost@nowhere.test')).toEqual([]);
  });
});

describe('merge-leads', () => {
  test('re-parents every child and leaves the loser dead', async () => {
    const winner = await seedLead('Winner Co', { lastContactedAt: T0 });
    const loser = await seedLead('Loser Co', {
      lastContactedAt: '2026-05-01T00:00:00.000Z',
      dnc: true,
    });
    await seedContact(winner, 'z@x.test');
    const c1 = await seedContact(loser, 'a@x.test');
    await seedContact(loser, 'b@x.test');
    await ctx.db.insert(opportunities).values({ leadId: loser, contactId: c1, valueCents: 100 });
    await ctx.db.insert(activities).values([
      { leadId: loser, contactId: c1, type: 'call_logged', occurredAt: T0 },
      { leadId: loser, type: 'note_added', occurredAt: T0 },
    ]);
    await ctx.db.insert(tasks).values({ leadId: loser, title: 'x', dueAt: T0 });
    await ctx.db.insert(notes).values({ leadId: loser, bodyMd: 'hi' });
    await ctx.db
      .insert(calls)
      .values({ leadId: loser, contactId: c1, direction: 'outbound', status: 'completed' });
    await ctx.db.insert(smsMessages).values({
      leadId: loser,
      direction: 'outbound',
      fromNumber: '+1',
      toNumber: '+2',
      status: 'sent',
    });
    await ctx.db.insert(emailThreads).values({ leadId: loser, subjectNorm: 'hello' });
    await ctx.db
      .insert(sequenceEnrollments)
      .values({ sequenceId: dims.sequenceId, leadId: loser, contactId: c1, state: 'active' });

    const result = await mergeLeads(ctx.db, { winnerId: winner, loserId: loser });

    expect(result.reparented).toMatchObject({
      contacts: 2,
      opportunities: 1,
      activities: 2,
      tasks: 1,
      notes: 1,
      emailThreads: 1,
      enrollments: 1,
      calls: 1,
      sms: 1,
    });
    expect(result.dedupedContacts).toHaveLength(0);

    // Winner now owns everything; loser owns nothing live.
    expect(await count(ctx.db, contacts, contacts.leadId, winner)).toBe(3);
    expect(await count(ctx.db, opportunities, opportunities.leadId, winner)).toBe(1);
    expect(await count(ctx.db, opportunities, opportunities.leadId, loser)).toBe(0);
    expect(await count(ctx.db, activities, activities.leadId, loser)).toBe(0);
    expect(await count(ctx.db, sequenceEnrollments, sequenceEnrollments.leadId, loser)).toBe(0);

    // Timeline shows lead_merged exactly once.
    const merged = await ctx.db
      .select()
      .from(activities)
      .where(and(eq(activities.leadId, winner), eq(activities.type, 'lead_merged')));
    expect(merged).toHaveLength(1);

    // Loser soft-deleted, denorm columns dead; DNC absorbed by winner.
    const [loserRow] = await ctx.db.select().from(leads).where(eq(leads.id, loser));
    expect(loserRow?.deletedAt).not.toBeNull();
    expect(loserRow?.lastContactedAt).toBeNull();
    const [winnerRow] = await ctx.db.select().from(leads).where(eq(leads.id, winner));
    expect(winnerRow?.dnc).toBe(true);
    expect(winnerRow?.lastContactedAt).toBe('2026-05-01 00:00:00+00');

    // Audit row written.
    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'lead.merged'));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entityId).toBe(winner);
  });

  test('dedupes contacts sharing an email deterministically and reports it', async () => {
    const winner = await seedLead('Winner Co');
    const loser = await seedLead('Loser Co');
    const wc = await seedContact(winner, 'shared@x.test');
    const lc = await seedContact(loser, 'shared@x.test');
    const [opp] = await ctx.db
      .insert(opportunities)
      .values({ leadId: loser, contactId: lc, valueCents: 5 })
      .returning({ id: opportunities.id });
    await ctx.db.insert(activities).values({ leadId: loser, contactId: lc, type: 'sms_sent', occurredAt: T0 });

    const result = await mergeLeads(ctx.db, { winnerId: winner, loserId: loser });

    expect(result.dedupedContacts).toEqual([
      { loserContactId: lc, survivingContactId: wc, matchedEmail: 'shared@x.test' },
    ]);
    expect(result.reparented.contacts).toBe(0); // the only loser contact was merged, not re-parented

    // The merged-away contact is soft-deleted; its children re-point to the survivor.
    const [lcRow] = await ctx.db.select().from(contacts).where(eq(contacts.id, lc));
    expect(lcRow?.deletedAt).not.toBeNull();
    const [oppRow] = await ctx.db.select().from(opportunities).where(eq(opportunities.id, opp?.id ?? ''));
    expect(oppRow?.contactId).toBe(wc);
    const [actRow] = await ctx.db
      .select()
      .from(activities)
      .where(and(eq(activities.leadId, winner), eq(activities.type, 'sms_sent')));
    expect(actRow?.contactId).toBe(wc);
  });

  test('resolves a live enrollment collision by unenrolling the duplicate', async () => {
    const winner = await seedLead('Winner Co');
    const loser = await seedLead('Loser Co');
    const wc = await seedContact(winner, 'shared@x.test');
    const lc = await seedContact(loser, 'shared@x.test');
    const [ew] = await ctx.db
      .insert(sequenceEnrollments)
      .values({ sequenceId: dims.sequenceId, leadId: winner, contactId: wc, state: 'active' })
      .returning({ id: sequenceEnrollments.id });
    const [el] = await ctx.db
      .insert(sequenceEnrollments)
      .values({ sequenceId: dims.sequenceId, leadId: loser, contactId: lc, state: 'active' })
      .returning({ id: sequenceEnrollments.id });

    const result = await mergeLeads(ctx.db, { winnerId: winner, loserId: loser });

    expect(result.unenrolledCollisions).toHaveLength(1);
    expect(result.unenrolledCollisions[0]?.enrollmentId).toBe(el?.id);

    const [elRow] = await ctx.db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, el?.id ?? ''));
    const [ewRow] = await ctx.db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, ew?.id ?? ''));
    expect(elRow?.state).toBe('unenrolled');
    expect(elRow?.pausedReason).toBe('merge_dedupe');
    expect(elRow?.contactId).toBe(wc);
    expect(ewRow?.state).toBe('active');
  });

  test('refuses to merge a lead into itself', async () => {
    const l = await seedLead('Self');
    await expect(mergeLeads(ctx.db, { winnerId: l, loserId: l })).rejects.toBeInstanceOf(SameLeadError);
  });

  test('refuses when a lead is missing', async () => {
    const winner = await seedLead('Winner');
    await expect(
      mergeLeads(ctx.db, { winnerId: winner, loserId: randomUUID() }),
    ).rejects.toBeInstanceOf(MergeLeadNotFoundError);
  });
});

describe('hard-delete-lead', () => {
  async function seedFullLead(): Promise<string> {
    const leadId = await seedLead('Doomed Co');
    const c1 = await seedContact(leadId, 'c1@x.test');
    await seedContact(leadId, 'c2@x.test');
    await ctx.db.insert(opportunities).values({ leadId, contactId: c1, valueCents: 1 });
    await ctx.db.insert(activities).values([
      { leadId, type: 'note_added', occurredAt: T0 },
      { leadId, contactId: c1, type: 'call_logged', occurredAt: T0 },
    ]);
    await ctx.db.insert(tasks).values({ leadId, title: 't', dueAt: T0 });
    await ctx.db.insert(notes).values({ leadId, bodyMd: 'n' });
    await ctx.db.insert(calls).values({ leadId, direction: 'outbound', status: 'completed' });
    await ctx.db
      .insert(smsMessages)
      .values({ leadId, direction: 'outbound', fromNumber: '+1', toNumber: '+2', status: 'sent' });
    await ctx.db.insert(emailThreads).values({ leadId, subjectNorm: 'hi' });
    const [enr] = await ctx.db
      .insert(sequenceEnrollments)
      .values({ sequenceId: dims.sequenceId, leadId, contactId: c1, state: 'finished' })
      .returning({ id: sequenceEnrollments.id });
    await ctx.db
      .insert(sendIntents)
      .values({ enrollmentId: enr?.id ?? '', stepId: dims.stepId, channel: 'email', dueAt: T0 });
    return leadId;
  }

  test('removes the whole graph in FK order with a complete audit trail', async () => {
    const leadId = await seedFullLead();
    const result = await hardDeleteLead(ctx.db, { leadId, reason: 'gdpr erasure' });

    expect(result.deleted).toMatchObject({
      contacts: 2,
      opportunities: 1,
      activities: 2,
      tasks: 1,
      notes: 1,
      calls: 1,
      sms: 1,
      enrollments: 1,
      sendIntents: 1,
    });
    expect(result.threadsUnlinked).toBe(1);

    // Zero orphan rows (FK-checked): nothing references the lead any more.
    expect(await count(ctx.db, contacts, contacts.leadId, leadId)).toBe(0);
    expect(await count(ctx.db, opportunities, opportunities.leadId, leadId)).toBe(0);
    expect(await count(ctx.db, activities, activities.leadId, leadId)).toBe(0);
    expect(await count(ctx.db, tasks, tasks.leadId, leadId)).toBe(0);
    expect(await count(ctx.db, notes, notes.leadId, leadId)).toBe(0);
    expect(await count(ctx.db, calls, calls.leadId, leadId)).toBe(0);
    expect(await count(ctx.db, smsMessages, smsMessages.leadId, leadId)).toBe(0);
    expect(await count(ctx.db, sequenceEnrollments, sequenceEnrollments.leadId, leadId)).toBe(0);
    expect(await count(ctx.db, emailThreads, emailThreads.leadId, leadId)).toBe(0);
    const [leadRow] = await ctx.db.select().from(leads).where(eq(leads.id, leadId));
    expect(leadRow).toBeUndefined();

    // The email thread survives, unlinked.
    const threads = await ctx.db.select().from(emailThreads);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.leadId).toBeNull();

    // Audit trail: requested (before snapshot) + completed.
    const requested = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'delete.hard_requested'));
    const completed = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'delete.hard_completed'));
    expect(requested).toHaveLength(1);
    expect(completed).toHaveLength(1);
    const before = requested[0]?.before as {
      lead?: { id?: string };
      counts?: { contacts?: number; sendIntents?: number };
    };
    expect(before.lead?.id).toBe(leadId);
    expect(before.counts?.contacts).toBe(2);
    // The before-snapshot's send_intent count (joined via enrollment) is accurate
    // and matches what was deleted (send_intents have no lead_id of their own).
    expect(before.counts?.sendIntents).toBe(1);
    expect(before.counts?.sendIntents).toBe(result.deleted.sendIntents);
  });

  test('refuses without a --reason', async () => {
    const leadId = await seedLead('X');
    await expect(hardDeleteLead(ctx.db, { leadId, reason: '   ' })).rejects.toBeInstanceOf(
      HardDeleteReasonRequiredError,
    );
    // Nothing was deleted.
    const [row] = await ctx.db.select().from(leads).where(eq(leads.id, leadId));
    expect(row).toBeDefined();
  });

  test('refuses open enrollments unless --force (then unenrolls first)', async () => {
    const leadId = await seedLead('Active Co');
    const c = await seedContact(leadId, 'c@x.test');
    await ctx.db
      .insert(sequenceEnrollments)
      .values({ sequenceId: dims.sequenceId, leadId, contactId: c, state: 'active' });

    await expect(hardDeleteLead(ctx.db, { leadId, reason: 'x' })).rejects.toBeInstanceOf(
      OpenEnrollmentsError,
    );
    // Rolled back — lead still present.
    expect((await ctx.db.select().from(leads).where(eq(leads.id, leadId)))[0]).toBeDefined();

    const forced = await hardDeleteLead(ctx.db, { leadId, reason: 'x', force: true });
    expect(forced.unenrolled).toBe(1);
    expect((await ctx.db.select().from(leads).where(eq(leads.id, leadId)))[0]).toBeUndefined();
    expect(await count(ctx.db, sequenceEnrollments, sequenceEnrollments.leadId, leadId)).toBe(0);
  });

  test('refuses when the lead does not exist', async () => {
    await expect(
      hardDeleteLead(ctx.db, { leadId: randomUUID(), reason: 'x' }),
    ).rejects.toBeInstanceOf(HardDeleteLeadNotFoundError);
  });
});

describe('runCli exit codes', () => {
  function sinks(): { out: string[]; err: string[]; outFn: (s: string) => void; errFn: (s: string) => void } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, outFn: (s) => out.push(s), errFn: (s) => err.push(s) };
  }

  test('no command → usage, exit 0', async () => {
    const s = sinks();
    const code = await runCli([], ctx.db, s.outFn, s.errFn);
    expect(code).toBe(0);
    expect(s.out.join('\n')).toContain('switchboard-admin');
  });

  test('hard-delete without --reason → exit 1', async () => {
    const leadId = await seedLead('X');
    const s = sinks();
    const code = await runCli(['hard-delete-lead', leadId], ctx.db, s.outFn, s.errFn);
    expect(code).toBe(1);
    expect(s.err.join('\n')).toContain('reason');
  });

  test('a refusal thrown by a command → exit 1', async () => {
    const l = await seedLead('Self');
    const s = sinks();
    const code = await runCli(['merge-leads', l, l], ctx.db, s.outFn, s.errFn);
    expect(code).toBe(1);
    expect(s.err.join('\n')).toContain('itself');
  });

  test('user-lookup happy path → exit 0', async () => {
    const s = sinks();
    const code = await runCli(['user-lookup', 'rep@x.test'], ctx.db, s.outFn, s.errFn);
    expect(code).toBe(0);
    expect(s.out.join('\n')).toContain('rep@x.test');
  });
});
