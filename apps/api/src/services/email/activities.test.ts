import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { activities } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { AmbiguousLeadMatcher } from '../sync/matcher.ts';
import { materializeThreadActivities } from './activities.ts';
import { ParticipantLeadMatcher } from './matching.ts';
import {
  activitiesFor,
  ingest,
  leadTouch,
  makeRaw,
  seedAccount,
  seedContact,
  seedLead,
  seedUser,
  threadsFor,
} from './test-helpers.ts';

/**
 * Email → activity materialization (task 2c, CONTRACTS §C4): a matched thread's
 * messages become exactly one `email_received`/`email_sent` each, written through
 * the sole ActivityWriter path (so the C1 denorm columns advance), never twice.
 */

const real = { matcher: new ParticipantLeadMatcher() };
const ambiguous = { matcher: new AmbiguousLeadMatcher() };

function iso(t: string): string {
  return new Date(t).toISOString();
}

let ctx: TestDb;
let accountId: string;

beforeEach(async () => {
  ctx = await createTestDb();
  const userId = await seedUser(ctx.db);
  accountId = await seedAccount(ctx.db, userId, 'rep@mock.test');
}, 60_000);
afterEach(async () => {
  await ctx.close();
});

describe('materialization on a matched thread', () => {
  test('inbound message → one email_received + advances last_email_at/last_inbound_at', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    await ingest(
      ctx.db,
      real,
      accountId,
      makeRaw({
        rfcMessageId: '<a@x>',
        from: 'a@ext.test',
        direction: 'in',
        subject: 'Deal',
        sentAt: '2026-03-01T09:00:00.000Z',
      }),
    );

    const acts = await activitiesFor(ctx.db, lead);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.type).toBe('email_received');
    expect(iso(acts[0]!.occurredAt)).toBe('2026-03-01T09:00:00.000Z');

    const touch = await leadTouch(ctx.db, lead);
    expect(iso(touch.lastEmailAt!)).toBe('2026-03-01T09:00:00.000Z');
    expect(iso(touch.lastInboundAt!)).toBe('2026-03-01T09:00:00.000Z');
    expect(touch.lastContactedAt).toBeNull(); // inbound does not set "contacted"
  });

  test('outbound message → one email_sent + advances last_email_at/last_contacted_at', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    await ingest(
      ctx.db,
      real,
      accountId,
      makeRaw({
        rfcMessageId: '<o@x>',
        from: 'rep@mock.test',
        to: ['a@ext.test'],
        direction: 'out',
        subject: 'Proposal',
        sentAt: '2026-03-02T09:00:00.000Z',
      }),
    );

    const acts = await activitiesFor(ctx.db, lead);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.type).toBe('email_sent');

    const touch = await leadTouch(ctx.db, lead);
    expect(iso(touch.lastContactedAt!)).toBe('2026-03-02T09:00:00.000Z');
    expect(iso(touch.lastEmailAt!)).toBe('2026-03-02T09:00:00.000Z');
    expect(touch.lastInboundAt).toBeNull();
  });

  test('payload carries emailMessageId, threadId and subject', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    await ingest(
      ctx.db,
      real,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Deal' }),
    );
    const rows = await ctx.db
      .select({ payload: activities.payload })
      .from(activities)
      .where(eq(activities.leadId, lead));
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(typeof payload['emailMessageId']).toBe('string');
    expect(typeof payload['threadId']).toBe('string');
    expect(payload['subject']).toBe('Deal');
  });

  test('every message in a matched thread appears exactly once', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    await ingest(
      ctx.db,
      real,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Deal' }),
    );
    await ingest(
      ctx.db,
      real,
      accountId,
      makeRaw({
        rfcMessageId: '<b@x>',
        from: 'a@ext.test',
        subject: 'Re: Deal',
        references: ['<a@x>'],
      }),
    );
    const acts = await activitiesFor(ctx.db, lead);
    expect(acts).toHaveLength(2);
    const messageIds = acts.map((a) => a.emailMessageId);
    expect(new Set(messageIds).size).toBe(2); // distinct messages, no double-write
  });
});

describe('exactly-once under replay', () => {
  test('re-ingesting matched-thread messages writes no extra activities', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    const raw = makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Deal' });
    await ingest(ctx.db, real, accountId, raw);
    await ingest(ctx.db, real, accountId, raw);
    await ingest(ctx.db, real, accountId, raw);
    expect(await activitiesFor(ctx.db, lead)).toHaveLength(1);
  });

  test('materializeThreadActivities is idempotent when called directly', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['a@ext.test']);
    await ingest(
      ctx.db,
      real,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Deal' }),
    );
    const [thread] = await threadsFor(ctx.db, accountId);
    // Already materialized during ingest → a direct re-run writes nothing.
    const written = await materializeThreadActivities(ctx.db, thread!.id, lead);
    expect(written).toBe(0);
  });
});

describe('ambiguous threads carry no activity until matched', () => {
  test('ambiguous ingest writes zero activities', async () => {
    const lead = await seedLead(ctx.db, 'Acme'); // exists, but no contact links it
    await ingest(
      ctx.db,
      ambiguous,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test' }),
    );
    expect(await activitiesFor(ctx.db, lead)).toHaveLength(0);
  });

  test('materializing an ambiguous thread later (triage resolve path) writes exactly once', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await ingest(
      ctx.db,
      ambiguous,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Deal' }),
    );
    const [thread] = await threadsFor(ctx.db, accountId);
    expect(thread!.triageStatus).toBe('ambiguous');

    const first = await materializeThreadActivities(ctx.db, thread!.id, lead);
    expect(first).toBe(1);
    const second = await materializeThreadActivities(ctx.db, thread!.id, lead);
    expect(second).toBe(0); // no correction, no double-write
    expect(await activitiesFor(ctx.db, lead)).toHaveLength(1);
  });
});
