import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { InferInsertModel } from 'drizzle-orm';

import { activities, calls, leads, users } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { runActivityReport } from './activity.ts';
import { activityReportRowSchema, type ActivityQuery } from './schemas.ts';

/**
 * Task 4g — activity report, exact numbers on seeded data (D-009 out-of-band
 * seeding). Covers direction/outcome call splits, talk time from `calls`, the
 * `user` vs `day` bucket modes, null-rep exclusion in user mode, the
 * zero-activity-rep edge, range filtering, and keyset pagination.
 */

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const LEAD = '11111111-0000-4000-8000-000000000001';

const DAY1 = '2026-03-15T12:00:00.000Z';
const DAY2 = '2026-03-16T12:00:00.000Z';
const OUT_BEFORE = '2026-02-20T12:00:00.000Z';
const OUT_AFTER = '2026-04-05T12:00:00.000Z';

type ActRow = InferInsertModel<typeof activities>;
type CallRow = InferInsertModel<typeof calls>;

let ctx: TestDb;

function act(
  type: ActRow['type'],
  userId: string | null,
  occurredAt: string,
  payload: Record<string, unknown> = {},
): ActRow {
  return { id: randomUUID(), leadId: LEAD, userId, type, occurredAt, payload };
}

function call(userId: string | null, startedAt: string, durationS: number | null): CallRow {
  return {
    id: randomUUID(),
    leadId: LEAD,
    userId,
    direction: 'outbound',
    status: 'completed',
    startedAt,
    durationS,
  };
}

function baseQuery(over: Partial<ActivityQuery>): ActivityQuery {
  return { from: '2026-03-01', to: '2026-03-31', groupBy: 'user', ...over };
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);

  await ctx.db.insert(users).values([
    { id: USER_A, email: 'a@example.com', name: 'Rep A', role: 'rep', idpSubject: 'idp|a' },
    { id: USER_B, email: 'b@example.com', name: 'Rep B', role: 'rep', idpSubject: 'idp|b' },
  ]);
  await ctx.db.insert(leads).values([{ id: LEAD, name: 'Acme', ownerId: USER_A }]);

  const rows: ActRow[] = [
    // USER_A, DAY1 — the fully-specified bucket.
    act('call_logged', USER_A, DAY1, { direction: 'inbound', outcome: 'connected' }),
    act('call_logged', USER_A, DAY1, { direction: 'inbound', outcome: 'connected' }),
    act('call_logged', USER_A, DAY1, { direction: 'outbound', outcome: 'voicemail' }),
    act('call_logged', USER_A, DAY1, { direction: 'outbound' }), // no outcome → "unknown"
    act('call_missed', USER_A, DAY1),
    act('call_missed', USER_A, DAY1),
    act('voicemail_received', USER_A, DAY1),
    act('email_sent', USER_A, DAY1),
    act('email_sent', USER_A, DAY1),
    act('email_sent', USER_A, DAY1),
    act('email_sent', USER_A, DAY1),
    act('email_sent', USER_A, DAY1),
    act('email_received', USER_A, DAY1),
    act('email_received', USER_A, DAY1),
    act('email_received', USER_A, DAY1),
    act('sms_sent', USER_A, DAY1),
    act('sms_sent', USER_A, DAY1),
    act('sms_received', USER_A, DAY1),
    act('note_added', USER_A, DAY1),
    act('note_added', USER_A, DAY1),
    act('task_completed', USER_A, DAY1),
    act('task_completed', USER_A, DAY1),
    act('task_completed', USER_A, DAY1),
    act('status_changed', USER_A, DAY1), // not a reported type → ignored
    // USER_A, DAY2.
    act('email_sent', USER_A, DAY2),
    act('call_logged', USER_A, DAY2, { direction: 'inbound', outcome: 'connected' }),
    // Out-of-range USER_A activity (must not count).
    act('email_sent', USER_A, OUT_BEFORE),
    act('email_sent', USER_A, OUT_AFTER),
    // Null-rep DAY1 emails: excluded in user mode, counted org-wide in day mode.
    act('email_sent', null, DAY1),
    act('email_sent', null, DAY1),
    // USER_B only has out-of-range activity → invisible in-range unless filtered.
    act('email_sent', USER_B, OUT_BEFORE),
  ];
  await ctx.db.insert(activities).values(rows);

  await ctx.db.insert(calls).values([
    call(USER_A, DAY1, 100),
    call(USER_A, DAY1, 200),
    call(USER_A, DAY1, 300),
    call(USER_A, DAY1, null), // null duration ignored by SUM
    call(USER_A, DAY2, 60),
    call(USER_A, OUT_AFTER, 999), // out of range
  ]);
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

describe('groupBy=user', () => {
  test('aggregates one row for the only in-range rep, exact numbers', async () => {
    const page = await runActivityReport(ctx.db, baseQuery({}));
    expect(page.items).toHaveLength(1);
    const row = page.items[0];
    if (row === undefined) throw new Error('expected a row');

    // Zod conformance (the response is contract-shaped).
    expect(activityReportRowSchema.parse(row)).toEqual(row);

    expect(row).toEqual({
      bucket: USER_A,
      callsLogged: 5,
      callsInbound: 3,
      callsOutbound: 2,
      callsByOutcome: { connected: 3, voicemail: 1, unknown: 1 },
      callsMissed: 2,
      voicemails: 1,
      emailsSent: 6, // null-rep emails excluded in user mode
      emailsReceived: 3,
      smsSent: 2,
      smsReceived: 1,
      notesAdded: 2,
      tasksCompleted: 3,
      talkTimeSeconds: 660,
    });
    expect(page.nextCursor).toBeUndefined();
  });

  test('userId filter returns just that rep', async () => {
    const page = await runActivityReport(ctx.db, baseQuery({ userId: USER_A }));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.bucket).toBe(USER_A);
    expect(page.items[0]?.callsLogged).toBe(5);
  });

  test('a rep with zero in-range activity still returns one all-zero row', async () => {
    const page = await runActivityReport(ctx.db, baseQuery({ userId: USER_B }));
    expect(page.items).toHaveLength(1);
    const row = page.items[0];
    expect(row?.bucket).toBe(USER_B);
    expect(row?.callsLogged).toBe(0);
    expect(row?.emailsSent).toBe(0);
    expect(row?.talkTimeSeconds).toBe(0);
    expect(row?.callsByOutcome).toEqual({});
  });

  test('an unknown userId yields an empty page (anchored on users)', async () => {
    const page = await runActivityReport(
      ctx.db,
      baseQuery({ userId: '00000000-0000-4000-8000-0000000000ff' }),
    );
    expect(page.items).toEqual([]);
  });
});

describe('groupBy=day', () => {
  test('buckets by UTC day and counts org-wide (null-rep included)', async () => {
    const page = await runActivityReport(ctx.db, baseQuery({ groupBy: 'day' }));
    expect(page.items.map((r) => r.bucket)).toEqual(['2026-03-15', '2026-03-16']);

    const d1 = page.items[0];
    expect(d1?.emailsSent).toBe(7); // 5 USER_A + 2 null-rep
    expect(d1?.callsLogged).toBe(4);
    expect(d1?.callsInbound).toBe(2);
    expect(d1?.callsOutbound).toBe(2);
    expect(d1?.callsByOutcome).toEqual({ connected: 2, voicemail: 1, unknown: 1 });
    expect(d1?.talkTimeSeconds).toBe(600);

    const d2 = page.items[1];
    expect(d2?.emailsSent).toBe(1);
    expect(d2?.callsLogged).toBe(1);
    expect(d2?.talkTimeSeconds).toBe(60);
  });

  test('userId filter in day mode excludes the null-rep rows', async () => {
    const page = await runActivityReport(ctx.db, baseQuery({ groupBy: 'day', userId: USER_A }));
    expect(page.items[0]?.bucket).toBe('2026-03-15');
    expect(page.items[0]?.emailsSent).toBe(5); // null-rep dropped
  });

  test('keyset pagination: limit=1 walks the days disjointly', async () => {
    const p1 = await runActivityReport(ctx.db, baseQuery({ groupBy: 'day', limit: 1 }));
    expect(p1.items).toHaveLength(1);
    expect(p1.items[0]?.bucket).toBe('2026-03-15');
    expect(typeof p1.nextCursor).toBe('string');

    const cursor = p1.nextCursor;
    if (cursor === undefined) throw new Error('expected a cursor');
    const p2 = await runActivityReport(ctx.db, baseQuery({ groupBy: 'day', limit: 1, cursor }));
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0]?.bucket).toBe('2026-03-16');
    expect(p2.nextCursor).toBeUndefined();
  });
});

describe('edge cases', () => {
  test('an empty range returns an empty page', async () => {
    const page = await runActivityReport(ctx.db, baseQuery({ from: '2026-01-01', to: '2026-01-31' }));
    expect(page.items).toEqual([]);
  });
});
