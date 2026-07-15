import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { InferInsertModel } from 'drizzle-orm';

import {
  activities,
  contacts,
  leads,
  sequenceEnrollments,
  sequences,
  users,
} from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { runSequencesReport } from './sequences.ts';
import { sequenceReportRowSchema, type SequencesQuery } from './schemas.ts';

/**
 * Task 4g — sequence performance report, exact numbers on seeded data (D-009:
 * the sequence engine may not be merged; we seed the C1 rows + C4 events
 * directly). Covers send/reply/bounce/unsubscribe/finish attribution via
 * enrollmentId, sequence_paused reason discrimination, the active/paused
 * enrollment snapshot, range scoping, the zero-activity sequence edge, and
 * unattributed events being dropped rather than erroring.
 */

const USER = '00000000-0000-4000-8000-00000000000a';
const LEAD = '11111111-0000-4000-8000-000000000001';
const SEQ_ONB = '44444444-0000-4000-8000-000000000001';
const SEQ_REN = '44444444-0000-4000-8000-000000000002';
const SEQ_ARC = '44444444-0000-4000-8000-000000000003';
const ENR_ONB = '55555555-0000-4000-8000-000000000001';
const ENR_REN = '55555555-0000-4000-8000-000000000002';

const C1 = '66666666-0000-4000-8000-000000000001';
const C2 = '66666666-0000-4000-8000-000000000002';
const C3 = '66666666-0000-4000-8000-000000000003';
const C4 = '66666666-0000-4000-8000-000000000004';

const IN_RANGE = '2026-03-10T12:00:00.000Z';
const OUT_RANGE = '2026-02-10T12:00:00.000Z';

type EnrRow = InferInsertModel<typeof sequenceEnrollments>;

let ctx: TestDb;

function seqEvent(type: 'sequence_step_sent' | 'sequence_paused' | 'sequence_finished', enrollmentId: string | null, occurredAt: string, reason?: string) {
  const payload: Record<string, unknown> = {};
  if (enrollmentId !== null) payload['enrollmentId'] = enrollmentId;
  if (reason !== undefined) payload['reason'] = reason;
  return { id: randomUUID(), leadId: LEAD, userId: USER, type, occurredAt, payload };
}

function enr(over: Partial<EnrRow> & Pick<EnrRow, 'sequenceId' | 'contactId' | 'state'>): EnrRow {
  return { id: over.id ?? randomUUID(), leadId: LEAD, ...over };
}

function rangedQuery(over: Partial<SequencesQuery> = {}): SequencesQuery {
  return { from: '2026-03-01', to: '2026-03-31', ...over };
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);

  await ctx.db
    .insert(users)
    .values([{ id: USER, email: 'a@example.com', name: 'Rep A', role: 'rep', idpSubject: 'idp|a' }]);
  await ctx.db.insert(leads).values([{ id: LEAD, name: 'Acme', ownerId: USER }]);
  await ctx.db.insert(contacts).values([
    { id: C1, leadId: LEAD, name: 'Contact 1' },
    { id: C2, leadId: LEAD, name: 'Contact 2' },
    { id: C3, leadId: LEAD, name: 'Contact 3' },
    { id: C4, leadId: LEAD, name: 'Contact 4' },
  ]);
  await ctx.db.insert(sequences).values([
    { id: SEQ_ONB, name: 'Onboarding', status: 'active' },
    { id: SEQ_REN, name: 'Renewal', status: 'active' },
    { id: SEQ_ARC, name: 'Archived Camp', status: 'archived' },
  ]);

  await ctx.db.insert(sequenceEnrollments).values([
    // Onboarding: 3 active + 1 paused (live → distinct contacts) + 1 finished.
    enr({ id: ENR_ONB, sequenceId: SEQ_ONB, contactId: C1, state: 'active' }),
    enr({ sequenceId: SEQ_ONB, contactId: C2, state: 'active' }),
    enr({ sequenceId: SEQ_ONB, contactId: C3, state: 'active' }),
    enr({ sequenceId: SEQ_ONB, contactId: C4, state: 'paused', pausedReason: 'reply' }),
    enr({ sequenceId: SEQ_ONB, contactId: C1, state: 'finished' }), // not live → no unique clash
    // Renewal: 1 active (C1 reusable — uniqueness is per sequence).
    enr({ id: ENR_REN, sequenceId: SEQ_REN, contactId: C1, state: 'active' }),
  ]);

  await ctx.db.insert(activities).values([
    // Onboarding events attributed via ENR_ONB.
    seqEvent('sequence_step_sent', ENR_ONB, IN_RANGE),
    seqEvent('sequence_step_sent', ENR_ONB, IN_RANGE),
    seqEvent('sequence_step_sent', ENR_ONB, IN_RANGE),
    seqEvent('sequence_step_sent', ENR_ONB, IN_RANGE),
    seqEvent('sequence_step_sent', ENR_ONB, IN_RANGE),
    seqEvent('sequence_paused', ENR_ONB, IN_RANGE, 'reply'),
    seqEvent('sequence_paused', ENR_ONB, IN_RANGE, 'reply'),
    seqEvent('sequence_paused', ENR_ONB, IN_RANGE, 'bounce'),
    seqEvent('sequence_paused', ENR_ONB, IN_RANGE, 'unsubscribe'),
    seqEvent('sequence_paused', ENR_ONB, IN_RANGE, 'manual'), // not a reply/bounce/unsub
    seqEvent('sequence_finished', ENR_ONB, IN_RANGE),
    seqEvent('sequence_step_sent', ENR_ONB, OUT_RANGE), // excluded when ranged
    // Renewal events.
    seqEvent('sequence_step_sent', ENR_REN, IN_RANGE),
    seqEvent('sequence_step_sent', ENR_REN, IN_RANGE),
    // Unattributed event (no enrollmentId) — dropped, not errored.
    seqEvent('sequence_step_sent', null, IN_RANGE),
  ]);
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

describe('sequences — ranged', () => {
  test('per-sequence exact counts, anchored on sequences (zero rows included)', async () => {
    const page = await runSequencesReport(ctx.db, rangedQuery());
    expect(page.items.map((r) => r.sequenceName)).toEqual(['Archived Camp', 'Onboarding', 'Renewal']);

    const onb = page.items.find((r) => r.sequenceId === SEQ_ONB);
    if (onb === undefined) throw new Error('expected Onboarding row');
    expect(sequenceReportRowSchema.parse(onb)).toEqual(onb);
    expect(onb).toEqual({
      sequenceId: SEQ_ONB,
      sequenceName: 'Onboarding',
      sequenceStatus: 'active',
      sends: 5, // out-of-range send excluded; unattributed send excluded
      replies: 2,
      bounces: 1,
      unsubscribes: 1,
      finishes: 1,
      activeEnrollments: 3,
      pausedEnrollments: 1,
    });

    const ren = page.items.find((r) => r.sequenceId === SEQ_REN);
    expect(ren).toMatchObject({ sends: 2, replies: 0, activeEnrollments: 1, pausedEnrollments: 0 });

    const arc = page.items.find((r) => r.sequenceId === SEQ_ARC);
    expect(arc).toEqual({
      sequenceId: SEQ_ARC,
      sequenceName: 'Archived Camp',
      sequenceStatus: 'archived',
      sends: 0,
      replies: 0,
      bounces: 0,
      unsubscribes: 0,
      finishes: 0,
      activeEnrollments: 0,
      pausedEnrollments: 0,
    });
  });

  test('sequenceId filter narrows to one sequence', async () => {
    const page = await runSequencesReport(ctx.db, rangedQuery({ sequenceId: SEQ_ONB }));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.sequenceId).toBe(SEQ_ONB);
  });
});

describe('sequences — all-time + pagination', () => {
  test('no range includes the out-of-range send', async () => {
    const page = await runSequencesReport(ctx.db, { sequenceId: SEQ_ONB });
    expect(page.items[0]?.sends).toBe(6); // 5 in-range + 1 out-of-range
  });

  test('keyset pages walk sequences by name disjointly', async () => {
    const p1 = await runSequencesReport(ctx.db, rangedQuery({ limit: 2 }));
    expect(p1.items.map((r) => r.sequenceName)).toEqual(['Archived Camp', 'Onboarding']);
    const cursor = p1.nextCursor;
    if (cursor === undefined) throw new Error('expected cursor');
    const p2 = await runSequencesReport(ctx.db, rangedQuery({ limit: 2, cursor }));
    expect(p2.items.map((r) => r.sequenceName)).toEqual(['Renewal']);
    expect(p2.nextCursor).toBeUndefined();
  });
});
