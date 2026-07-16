import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

import {
  contacts,
  emailAccounts,
  emailMessages,
  emailThreads,
  leads,
  sendIntents,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  tasks,
  templates,
  users,
  type Db,
} from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import type { EnqueueOptions, JobData, QueueDriver } from '../queue/index.ts';
import { registerInboxRoutes } from './inbox.ts';

/**
 * TASK R4 — inbox routes over real Postgres (PGlite). Seeds the three real sources
 * (unanswered threads · due tasks · AWAITING_REVIEW send-intents) and asserts the
 * composed queue order + fields + stats math EXACTLY, then the rail-safe review
 * dispositions (approve releases to SCHEDULED, DNC → 422, skip → SKIPPED), the
 * conflict / not-found / validation failure paths, and the non-persisted snooze.
 */

const NOW = '2026-07-15T17:00:00.000Z';
const nowFn = (): Date => new Date(NOW);

let ctx: TestDb;
let app: FastifyInstance;
let accountId: string;

// --- seed helpers -----------------------------------------------------------

async function seedLead(db: Db, name: string, dnc = false): Promise<string> {
  const [r] = await db.insert(leads).values({ name, dnc }).returning({ id: leads.id });
  return r!.id;
}
async function seedContact(db: Db, leadId: string, name: string, email: string): Promise<string> {
  const [r] = await db
    .insert(contacts)
    .values({ leadId, name, emails: [{ email, type: 'work' }] })
    .returning({ id: contacts.id });
  return r!.id;
}
async function seedTask(
  db: Db,
  leadId: string,
  values: { title: string; dueAt: string | null; completedAt?: string | null },
): Promise<string> {
  const [r] = await db
    .insert(tasks)
    .values({
      leadId,
      title: values.title,
      dueAt: values.dueAt,
      completedAt: values.completedAt ?? null,
    })
    .returning({ id: tasks.id });
  return r!.id;
}
async function seedThread(
  db: Db,
  leadId: string,
  msgs: {
    direction: 'in' | 'out';
    from: string;
    subject: string;
    snippet: string;
    sentAt: string;
  }[],
): Promise<string> {
  const [t] = await db
    .insert(emailThreads)
    .values({ leadId, subjectNorm: msgs[0]?.subject ?? null, triageStatus: 'matched' })
    .returning({ id: emailThreads.id });
  const threadId = t!.id;
  let seq = 0;
  for (const m of msgs) {
    seq += 1;
    await db.insert(emailMessages).values({
      accountId,
      threadId,
      rfcMessageId: `<${threadId}-${seq}@t.test>`,
      direction: m.direction,
      fromAddr: m.from,
      subject: m.subject,
      snippet: m.snippet,
      sentAt: m.sentAt,
    });
  }
  return threadId;
}

interface ReviewSeed {
  leadDnc?: boolean;
  state?: 'AWAITING_REVIEW' | 'SENT' | 'SKIPPED';
  updatedAt?: string;
}

/** Seed lead+contact+sequence(3 steps)+enrollment+one intent on step 2; returns ids. */
async function seedReview(
  db: Db,
  opts: ReviewSeed = {},
): Promise<{ intentId: string; leadId: string }> {
  const leadId = await seedLead(db, 'Rev Co', opts.leadDnc ?? false);
  const contactId = await seedContact(db, leadId, 'Val', 'val@rev.test');
  const [tpl] = await db
    .insert(templates)
    .values({
      name: 'S2',
      channel: 'email',
      subject: 'Step 2 subject',
      body: 'Hi there, quick note.',
    })
    .returning({ id: templates.id });
  const [seq] = await db
    .insert(sequences)
    .values({ name: 'Onboarding' })
    .returning({ id: sequences.id });
  const stepRows = await db
    .insert(sequenceSteps)
    .values([
      { sequenceId: seq!.id, sortOrder: 1, type: 'email', requiresReview: false },
      {
        sequenceId: seq!.id,
        sortOrder: 2,
        type: 'email',
        requiresReview: true,
        templateId: tpl!.id,
      },
      {
        sequenceId: seq!.id,
        sortOrder: 3,
        type: 'email',
        requiresReview: true,
        templateId: tpl!.id,
      },
    ])
    .returning({ id: sequenceSteps.id, sortOrder: sequenceSteps.sortOrder });
  const step2 = stepRows.find((s) => s.sortOrder === 2)!;
  const [enr] = await db
    .insert(sequenceEnrollments)
    .values({ sequenceId: seq!.id, leadId, contactId, state: 'active' })
    .returning({ id: sequenceEnrollments.id });
  const [intent] = await db
    .insert(sendIntents)
    .values({
      enrollmentId: enr!.id,
      stepId: step2.id,
      channel: 'email',
      dueAt: '2026-07-15T12:00:00.000Z',
      state: opts.state ?? 'AWAITING_REVIEW',
      ...(opts.updatedAt !== undefined ? { updatedAt: opts.updatedAt } : {}),
    })
    .returning({ id: sendIntents.id });
  return { intentId: intent!.id, leadId };
}

beforeAll(async () => {
  ctx = await createTestDb();
  const db = ctx.db;
  const [u] = await db
    .insert(users)
    .values({ email: 'rep@x.test', name: 'Rep', role: 'rep', idpSubject: 'idp|rep' })
    .returning({ id: users.id });
  const [acc] = await db
    .insert(emailAccounts)
    .values({ userId: u!.id, address: 'rep@mock.test', provider: 'mock' })
    .returning({ id: emailAccounts.id });
  accountId = acc!.id;

  app = Fastify({ logger: false });
  registerInboxRoutes(app, { db, now: nowFn });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('GET /inbox + /stats (exact over seeded rows)', () => {
  let expectedThreadOpenId: string;
  let expectedReviewId: string;

  beforeAll(async () => {
    const db = ctx.db;
    const la = await seedLead(db, 'Acme');
    const lb = await seedLead(db, 'Beta');
    await seedContact(db, la, 'Dana', 'dana@acme.test');

    // tasks
    await seedTask(db, la, { title: 'Overdue call', dueAt: '2026-07-14T09:00:00.000Z' });
    await seedTask(db, la, { title: 'Due today', dueAt: '2026-07-15T09:00:00.000Z' });
    await seedTask(db, lb, { title: 'Future', dueAt: '2026-07-16T09:00:00.000Z' }); // excluded
    await seedTask(db, la, {
      title: 'Done',
      dueAt: '2026-07-13T09:00:00.000Z',
      completedAt: '2026-07-15T08:00:00.000Z', // doneToday +1
    });

    // threads
    expectedThreadOpenId = await seedThread(db, la, [
      {
        direction: 'in',
        from: 'dana@acme.test',
        subject: 'Re: pricing',
        snippet: 'looks good',
        sentAt: '2026-07-15T16:00:00.000Z',
      },
    ]);
    await seedThread(db, la, [
      {
        direction: 'in',
        from: 'stranger@x.test',
        subject: 'Question',
        snippet: 'hi',
        sentAt: '2026-07-15T15:00:00.000Z',
      },
    ]);
    await seedThread(db, lb, [
      {
        direction: 'in',
        from: 'ben@beta.test',
        subject: 'Ping',
        snippet: 'yo',
        sentAt: '2026-07-15T10:00:00.000Z',
      },
      {
        direction: 'out',
        from: 'rep@mock.test',
        subject: 'Re: Ping',
        snippet: 'hello',
        sentAt: '2026-07-15T11:00:00.000Z',
      }, // answered → doneToday +1
    ]);

    // review (I1 AWAITING_REVIEW) + a skipped-today review sharing the enrollment
    const rev = await seedReview(db);
    expectedReviewId = rev.intentId;
    // second intent on step 3 of that enrollment, SKIPPED today → doneToday +1
    const enr = await db
      .select({ id: sequenceEnrollments.id, seqId: sequenceEnrollments.sequenceId })
      .from(sequenceEnrollments)
      .limit(1);
    const steps = await db
      .select({ id: sequenceSteps.id, sortOrder: sequenceSteps.sortOrder })
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, enr[0]!.seqId));
    const s3 = steps.find((s) => s.sortOrder === 3)!;
    await db.insert(sendIntents).values({
      enrollmentId: enr[0]!.id,
      stepId: s3.id,
      channel: 'email',
      dueAt: '2026-07-15T13:00:00.000Z',
      state: 'SKIPPED',
      skipReason: 'review_skipped',
      updatedAt: '2026-07-15T10:30:00.000Z',
    });
  });

  test('GET /inbox returns the merged queue in exact order', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/inbox' });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { id: string; kind: string }[];
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['task', 'task', 'reply', 'reply', 'review']);
    // tasks by dueAt asc; replies by receivedAt desc; then the review
    expect(items[2]!.id).toBe(`reply:${expectedThreadOpenId}`); // 16:00 newest first
    expect(items[4]!.id).toBe(`review:${expectedReviewId}`);
  });

  test('reply item resolves the matched contact + reply-to address', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/inbox' });
    const items = res.json().items as Record<string, unknown>[];
    const open = items.find((i) => i['id'] === `reply:${expectedThreadOpenId}`)!;
    expect(open).toMatchObject({
      kind: 'reply',
      leadName: 'Acme',
      contactName: 'Dana',
      toAddress: 'dana@acme.test',
      subject: 'Re: pricing',
      snippet: 'looks good',
      channel: 'email',
      receivedAt: '2026-07-15T16:00:00.000Z',
    });
    expect(open['contactId']).not.toBeNull();

    // the unmatched inbound falls back to the from-address as the contact name
    const stranger = items.find(
      (i) => i['kind'] === 'reply' && i['id'] !== `reply:${expectedThreadOpenId}`,
    )!;
    expect(stranger['contactId']).toBeNull();
    expect(stranger['contactName']).toBe('stranger@x.test');
  });

  test('task overdue flag + review step label are exact', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/inbox' });
    const items = res.json().items as Record<string, unknown>[];
    const overdue = items.find((i) => i['kind'] === 'task' && i['title'] === 'Overdue call')!;
    const dueToday = items.find((i) => i['kind'] === 'task' && i['title'] === 'Due today')!;
    expect(overdue['overdue']).toBe(true);
    expect(dueToday['overdue']).toBe(false);
    const review = items.find((i) => i['kind'] === 'review')!;
    expect(review['stepLabel']).toBe('Step 2 of 3 · Email');
    expect(review['sequenceName']).toBe('Onboarding');
    expect(review['subject']).toBe('Step 2 subject');
    expect(review['preview']).toBe('Hi there, quick note.');
  });

  test('GET /inbox/stats math is exact', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/inbox/stats' });
    expect(res.statusCode).toBe(200);
    // 2 tasks + 2 replies + 1 review open = 5 ; overdue = task count = 2 ;
    // doneToday = completed task(1) + answered thread(1) + skipped review(1) = 3
    expect(res.json()).toEqual({ needsYouNow: 5, overdue: 2, doneToday: 3 });
  });
});

describe('review actions', () => {
  test('approve releases AWAITING_REVIEW → SCHEDULED and enqueues a send', async () => {
    const enqueued: { name: string; data: JobData; opts?: EnqueueOptions }[] = [];
    const queue: QueueDriver = {
      enqueue: async (name, data, opts) => {
        enqueued.push({ name, data, ...(opts !== undefined ? { opts } : {}) });
      },
      process: () => {},
      close: async () => {},
    };
    const qApp = Fastify({ logger: false });
    registerInboxRoutes(qApp, { db: ctx.db, now: nowFn, queue });
    await qApp.ready();

    const { intentId } = await seedReview(ctx.db);
    const res = await qApp.inject({
      method: 'POST',
      url: `/api/v1/inbox/reviews/${intentId}/approve`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: intentId, state: 'SCHEDULED', disposition: 'approved' });

    const [row] = await ctx.db
      .select({ state: sendIntents.state })
      .from(sendIntents)
      .where(eq(sendIntents.id, intentId));
    expect(row!.state).toBe('SCHEDULED');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.name).toBe('sequence:send');
    expect(enqueued[0]!.data).toEqual({ intentId });
    await qApp.close();
  });

  test('approve on a DNC lead → 422 SUPPRESSED, intent stays AWAITING_REVIEW', async () => {
    const { intentId } = await seedReview(ctx.db, { leadDnc: true });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/inbox/reviews/${intentId}/approve`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SUPPRESSED');
    const [row] = await ctx.db
      .select({ state: sendIntents.state })
      .from(sendIntents)
      .where(eq(sendIntents.id, intentId));
    expect(row!.state).toBe('AWAITING_REVIEW');
  });

  test('skip marks the step SKIPPED', async () => {
    const { intentId } = await seedReview(ctx.db);
    const res = await app.inject({ method: 'POST', url: `/api/v1/inbox/reviews/${intentId}/skip` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: intentId, state: 'SKIPPED', disposition: 'skipped' });
    const [row] = await ctx.db
      .select({ state: sendIntents.state, skipReason: sendIntents.skipReason })
      .from(sendIntents)
      .where(eq(sendIntents.id, intentId));
    expect(row!.state).toBe('SKIPPED');
    expect(row!.skipReason).toBe('review_skipped');
  });

  test('approve an already-dispositioned step → 409 CONFLICT', async () => {
    const { intentId } = await seedReview(ctx.db, { state: 'SENT' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/inbox/reviews/${intentId}/approve`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  test('unknown review id → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/inbox/reviews/00000000-0000-4000-8000-0000000000ee/approve',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  test('non-uuid review id → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/inbox/reviews/nope/skip' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('snooze (non-persisted, D-030)', () => {
  test('returns the next-day boundary for the item', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/inbox/snooze',
      payload: { itemId: 'reply:abc-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'reply:abc-123', snoozedUntil: '2026-07-16T00:00:00.000Z' });
  });

  test('missing itemId → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/inbox/snooze', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});
