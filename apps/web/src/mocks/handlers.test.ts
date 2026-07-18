import { describe, expect, test } from 'vitest';
import { parse } from '@switchboard/shared';
import { ApiError } from '../api/errors.ts';
import {
  createSmartView,
  deleteSmartView,
  getSmartView,
  listSmartViews,
  updateSmartView,
} from '../api/smartViews.ts';
import { createTask } from '../api/tasks.ts';
import { db } from './fixtures.ts';
import { mulberry32 } from './seed.ts';

const REFERENCE_NOW = Date.parse('2026-07-15T17:00:00.000Z');

describe('fixture invariants', () => {
  test('realistic lead volume (200+)', () => {
    expect(db.leads.length).toBeGreaterThanOrEqual(200);
  });

  test('leads carry the denormalized hot columns with varied state', () => {
    expect(db.leads.every((l) => typeof l.dnc === 'boolean')).toBe(true);
    // at least one DNC lead
    expect(db.leads.some((l) => l.dnc)).toBe(true);
    // at least one overdue (nextTaskDueAt in the past)
    expect(
      db.leads.some((l) => l.nextTaskDueAt !== null && Date.parse(l.nextTaskDueAt) < REFERENCE_NOW),
    ).toBe(true);
    // at least one "new reply" (inbound within 48h)
    expect(
      db.leads.some(
        (l) =>
          l.lastInboundAt !== null &&
          REFERENCE_NOW - Date.parse(l.lastInboundAt) < 48 * 3600 * 1000,
      ),
    ).toBe(true);
  });

  test('every lead has a non-empty timeline', () => {
    for (const lead of db.leads) {
      expect(db.activitiesByLead.get(lead.id)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('shipped smart views all carry valid DSL', () => {
    expect(db.smartViews.length).toBeGreaterThanOrEqual(6);
    for (const view of db.smartViews) {
      expect(() => parse(view.dsl)).not.toThrow();
    }
  });

  test('PRNG is deterministic for a fixed seed', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const seqA = [a(), a(), a(), a()];
    expect([b(), b(), b(), b()]).toEqual(seqA);
    const c = mulberry32(124);
    expect([c(), c(), c(), c()]).not.toEqual(seqA);
  });
});

describe('smart-view CRUD handlers', () => {
  test('create → list → get → delete → 404', async () => {
    const before = (await listSmartViews()).length;
    const created = await createSmartView({ name: 'Temp view', dsl: 'dnc = true', shared: false });
    expect(created.id).toBeTruthy();
    expect(created.ast).toBeTruthy();

    const list = await listSmartViews();
    expect(list.length).toBe(before + 1);
    expect(list.some((v) => v.id === created.id)).toBe(true);

    const fetched = await getSmartView(created.id);
    expect(fetched.id).toBe(created.id);

    await deleteSmartView(created.id);
    expect((await listSmartViews()).length).toBe(before);

    const err: unknown = await getSmartView(created.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    if (err instanceof ApiError) expect(err.code).toBe('NOT_FOUND');
  });

  test('patch updates the name and re-parses the DSL', async () => {
    const created = await createSmartView({ name: 'Patch me', dsl: 'dnc = true' });
    try {
      const updated = await updateSmartView(created.id, {
        name: 'Patched',
        dsl: 'status = "Won"',
      });
      expect(updated.name).toBe('Patched');
      expect(updated.dsl).toBe('status = "Won"');
    } finally {
      await deleteSmartView(created.id);
    }
  });

  // failure path: invalid DSL is rejected at create
  test('create with invalid DSL → VALIDATION_FAILED', async () => {
    const err: unknown = await createSmartView({ name: 'Bad', dsl: 'status ~~ 1' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    if (err instanceof ApiError) expect(err.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /tasks (C7 create — the lead-page Task action)', () => {
  test('creates the task and lands a task_created activity on the timeline', async () => {
    const lead = db.leads.find((l) => l.deletedAt === null);
    if (!lead) throw new Error('fixtures must include a live lead');
    const before = db.activitiesByLead.get(lead.id)?.length ?? 0;

    const task = await createTask({
      leadId: lead.id,
      title: 'Send the revised quote',
      dueAt: null,
    });
    expect(task.leadId).toBe(lead.id);
    expect(task.title).toBe('Send the revised quote');
    expect(task.completedAt).toBeNull();

    const events = db.activitiesByLead.get(lead.id) ?? [];
    expect(events.length).toBe(before + 1);
    // Timeline is newest-first; the fresh activity carries the title.
    expect(events[0]?.type).toBe('task_created');
    expect(events[0]?.payload).toMatchObject({ title: 'Send the revised quote' });
  });

  test("a sooner due date tightens the lead's denormalized nextTaskDueAt", async () => {
    const lead = db.leads.find((l) => l.deletedAt === null && l.nextTaskDueAt !== null);
    if (!lead) throw new Error('fixtures must include a lead with a due task');
    const sooner = new Date(Date.parse(lead.nextTaskDueAt as string) - 86_400_000).toISOString();
    await createTask({ leadId: lead.id, title: 'Jump the queue', dueAt: sooner });
    expect(lead.nextTaskDueAt).toBe(sooner);
  });

  test('validates: blank title is 400, unknown lead is 404', async () => {
    const lead = db.leads[0];
    if (!lead) throw new Error('fixtures must include leads');
    const blank = await createTask({ leadId: lead.id, title: '   ' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(blank).toBeInstanceOf(ApiError);
    if (blank instanceof ApiError) expect(blank.code).toBe('VALIDATION_FAILED');

    const missing = await createTask({
      leadId: '00000000-0000-4000-8000-000000000000',
      title: 'x',
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(missing).toBeInstanceOf(ApiError);
    if (missing instanceof ApiError) expect(missing.code).toBe('NOT_FOUND');
  });
});
