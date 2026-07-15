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
