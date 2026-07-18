import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { activities, leads } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { ActivityWriter, LeadNotFoundError, recordActivity } from './writer.ts';

let ctx: TestDb;

beforeEach(async () => {
  ctx = await createTestDb();
});

afterEach(async () => {
  await ctx.close();
});

async function seedLead(): Promise<string> {
  const [row] = await ctx.db
    .insert(leads)
    .values({ name: 'Acme Corp' })
    .returning({ id: leads.id });
  if (!row) throw new Error('seed failed');
  return row.id;
}

async function fetchLead(id: string) {
  const [row] = await ctx.db.select().from(leads).where(eq(leads.id, id));
  if (!row) throw new Error('lead not found');
  return row;
}

async function countActivities(): Promise<number> {
  const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(activities);
  return row?.n ?? 0;
}

const iso = (s: string) => new Date(s).toISOString();

describe('ActivityWriter payload validation', () => {
  test('rejects a payload that violates the C4 schema, writing nothing', async () => {
    const leadId = await seedLead();
    await expect(
      // field_changed requires {field, before, after}; omit `field`.
      recordActivity(ctx.db, {
        leadId,
        type: 'field_changed',
        occurredAt: '2026-05-01T00:00:00.000Z',
        payload: { before: 1, after: 2 },
      }),
    ).rejects.toThrow();
    expect(await countActivities()).toBe(0);
  });

  test('accepts a valid payload and appends exactly one row', async () => {
    const leadId = await seedLead();
    const row = await recordActivity(ctx.db, {
      leadId,
      type: 'field_changed',
      occurredAt: '2026-05-01T00:00:00.000Z',
      payload: { field: 'status', before: 'a', after: 'b' },
    });
    expect(row.type).toBe('field_changed');
    expect(row.leadId).toBe(leadId);
    expect(await countActivities()).toBe(1);
  });
});

describe('ActivityWriter webhook emission (activity.recorded fan-out)', () => {
  interface StagedEvent {
    type: string;
    data: Record<string, unknown>;
  }

  test('stages an activity.recorded event in-tx and flushes the delivery ids post-commit', async () => {
    const leadId = await seedLead();
    const staged: StagedEvent[] = [];
    const flushed: string[][] = [];
    const emitter = {
      stage: async (_tx: unknown, event: StagedEvent): Promise<string[]> => {
        staged.push(event);
        return ['delivery-1'];
      },
      flush: async (ids: string[]): Promise<void> => {
        flushed.push(ids);
      },
    };

    await recordActivity(
      ctx.db,
      {
        leadId,
        type: 'field_changed',
        occurredAt: '2026-05-01T00:00:00.000Z',
        payload: { field: 'status', before: 'a', after: 'b' },
      },
      emitter,
    );

    // ONE coarse wire event carrying the fine-grained C4 type in its data.
    expect(staged).toHaveLength(1);
    expect(staged[0]?.type).toBe('activity.recorded');
    expect(staged[0]?.data['activityType']).toBe('field_changed');
    expect(staged[0]?.data['leadId']).toBe(leadId);
    // Enqueue happens exactly once, after commit, with the staged ids.
    expect(flushed).toEqual([['delivery-1']]);
  });

  test('does not flush when the activity record fails (rolled back, no orphan delivery)', async () => {
    const flushed: string[][] = [];
    const emitter = {
      stage: async (): Promise<string[]> => ['delivery-1'],
      flush: async (ids: string[]): Promise<void> => {
        flushed.push(ids);
      },
    };

    await expect(
      recordActivity(
        ctx.db,
        {
          // no such lead → the whole transaction rolls back
          leadId: '00000000-0000-0000-0000-000000000000',
          type: 'field_changed',
          occurredAt: '2026-05-01T00:00:00.000Z',
          payload: { field: 'status', before: 'a', after: 'b' },
        },
        emitter,
      ),
    ).rejects.toThrow();

    expect(flushed).toEqual([]);
  });

  test('no emitter (existing callers) records normally with no fan-out', async () => {
    const leadId = await seedLead();
    const row = await recordActivity(ctx.db, {
      leadId,
      type: 'note_added',
      occurredAt: '2026-05-01T00:00:00.000Z',
      payload: { body: 'hello' },
    });
    expect(row.type).toBe('note_added');
  });
});

describe('ActivityWriter denormalization mapping (CONTRACTS §C4)', () => {
  // Each case: event type → the lead columns that must advance to occurred_at.
  const T = '2026-05-01T12:00:00.000Z';
  const cases: {
    type: Parameters<typeof recordActivity>[1]['type'];
    payload?: Record<string, unknown>;
    expect: (keyof Awaited<ReturnType<typeof fetchLead>>)[];
  }[] = [
    { type: 'call_logged', expect: ['lastCallAt', 'lastContactedAt'] },
    { type: 'call_missed', expect: ['lastCallAt'] },
    { type: 'voicemail_received', expect: ['lastCallAt'] },
    { type: 'email_sent', expect: ['lastEmailAt', 'lastContactedAt'] },
    { type: 'email_received', expect: ['lastEmailAt', 'lastInboundAt'] },
    { type: 'sms_sent', expect: ['lastSmsAt', 'lastContactedAt'] },
    { type: 'sms_received', expect: ['lastSmsAt', 'lastInboundAt'] },
    { type: 'sequence_step_sent', expect: ['lastContactedAt'] },
  ];

  const touchColumns = [
    'lastContactedAt',
    'lastInboundAt',
    'lastCallAt',
    'lastEmailAt',
    'lastSmsAt',
  ] as const;

  for (const c of cases) {
    test(`${c.type} advances ${c.expect.join('+')}`, async () => {
      const leadId = await seedLead();
      await recordActivity(ctx.db, {
        leadId,
        type: c.type,
        occurredAt: T,
        payload: c.payload ?? {},
      });
      const lead = await fetchLead(leadId);
      for (const col of touchColumns) {
        const value = lead[col];
        if (c.expect.includes(col)) {
          expect(value, `${col} should be set`).not.toBeNull();
          expect(iso(value as string)).toBe(iso(T));
        } else {
          expect(value, `${col} should stay null`).toBeNull();
        }
      }
    });
  }

  test('last-touch columns are monotonic — an older event never regresses them', async () => {
    const leadId = await seedLead();
    await recordActivity(ctx.db, {
      leadId,
      type: 'email_sent',
      occurredAt: '2026-05-10T00:00:00.000Z',
      payload: {},
    });
    await recordActivity(ctx.db, {
      leadId,
      type: 'email_sent',
      occurredAt: '2026-05-01T00:00:00.000Z', // older
      payload: {},
    });
    const lead = await fetchLead(leadId);
    expect(iso(lead.lastContactedAt as string)).toBe(iso('2026-05-10T00:00:00.000Z'));
  });
});

describe('ActivityWriter next_task_due_at recompute', () => {
  test('task_created sets, task_completed clears next_task_due_at from open tasks', async () => {
    const leadId = await seedLead();
    const due = '2026-06-15T09:00:00.000Z';
    // Insert an open task, then record the creation event.
    const [task] = await ctx.db
      .insert((await import('../../db/index.ts')).tasks)
      .values({ leadId, title: 'Follow up', dueAt: due })
      .returning({ id: (await import('../../db/index.ts')).tasks.id });
    if (!task) throw new Error('task seed failed');

    await recordActivity(ctx.db, {
      leadId,
      type: 'task_created',
      occurredAt: '2026-05-01T00:00:00.000Z',
      payload: { taskId: task.id, dueAt: due },
    });
    expect(iso((await fetchLead(leadId)).nextTaskDueAt as string)).toBe(iso(due));

    // Complete the task, then record completion → recompute to null (no open tasks).
    const mod = await import('../../db/index.ts');
    await ctx.db
      .update(mod.tasks)
      .set({ completedAt: '2026-05-02T00:00:00.000Z' })
      .where(eq(mod.tasks.id, task.id));
    await recordActivity(ctx.db, {
      leadId,
      type: 'task_completed',
      occurredAt: '2026-05-02T00:00:00.000Z',
      payload: { taskId: task.id },
    });
    expect((await fetchLead(leadId)).nextTaskDueAt).toBeNull();
  });
});

describe('ActivityWriter transactionality', () => {
  test('a failed record leaves BOTH the activity and the denorm columns untouched', async () => {
    const leadId = await seedLead();
    // Soft-delete the lead: record() must refuse (its denorm UPDATE matches 0 rows)
    // and roll the append back with it.
    await ctx.db
      .update(leads)
      .set({ deletedAt: '2026-05-01T00:00:00.000Z' })
      .where(eq(leads.id, leadId));
    const before = await fetchLead(leadId);

    await expect(
      recordActivity(ctx.db, {
        leadId,
        type: 'email_sent',
        occurredAt: '2026-05-05T00:00:00.000Z',
        payload: {},
      }),
    ).rejects.toBeInstanceOf(LeadNotFoundError);

    // Append rolled back …
    expect(await countActivities()).toBe(0);
    // … and the denorm columns are exactly as before (still null).
    const after = await fetchLead(leadId);
    expect(after.lastContactedAt).toBe(before.lastContactedAt);
    expect(after.lastEmailAt).toBe(before.lastEmailAt);
  });
});

describe('ActivityWriter class wrapper', () => {
  test('exposes record() bound to a db handle', async () => {
    const leadId = await seedLead();
    const writer = new ActivityWriter(ctx.db);
    const row = await writer.record({
      leadId,
      type: 'note_added',
      occurredAt: '2026-05-01T00:00:00.000Z',
      payload: {},
    });
    expect(row.id).toBeDefined();
    expect(await countActivities()).toBe(1);
  });
});
