import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { InferInsertModel } from 'drizzle-orm';

import { activities, sequenceEnrollments, sequences } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { loadGoldenFixtures } from '../fixtures/loader.ts';
import { runActivityReport } from './activity.ts';
import { runFunnelReport } from './funnel.ts';
import { runSequencesReport } from './sequences.ts';

/**
 * Task 4g — perf sanity on the 5k golden fixture (ARCHITECTURE §9). Aggregates
 * are allowed more than the 150ms core-read budget; the acceptance bound is
 * < 500ms per report query. PGlite/WASM timings are NON-AUTHORITATIVE (the real
 * gate is Postgres, DECISIONS D-003) — this is a regression tripwire that the
 * queries stay in the right order of magnitude on realistic data.
 *
 * A modest overlay (sequences + enrollments + sequence and stage-change events)
 * is seeded so the funnel conversion join and the sequence attribution join do
 * real work, not just the activity spine.
 */

const BUDGET_MS = 500;
const ITERATIONS = 5;
const OVERLAY_WHEN = '2026-03-15T12:00:00.000Z';
const SEQ_A = 'aaaa1111-0000-4000-8000-000000000001';
const SEQ_B = 'aaaa1111-0000-4000-8000-000000000002';

type ActRow = InferInsertModel<typeof activities>;

let ctx: TestDb;
let seeded = false;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
}

async function timed(label: string, fn: () => Promise<unknown>): Promise<number> {
  await fn(); // warm up
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  const med = median(samples);
  console.log(
    `[perf] ${label}: median ${med.toFixed(1)}ms  max ${Math.max(...samples).toFixed(1)}ms`,
  );
  return med;
}

async function seedOverlay(db: TestDb): Promise<void> {
  const stageRows = (await db.client.query<{ id: string }>('SELECT id FROM opportunity_stages'))
    .rows;
  const stageIds = stageRows.map((r) => r.id);
  const contactRows = (
    await db.client.query<{ id: string; lead_id: string }>(
      'SELECT id, lead_id FROM contacts LIMIT 400',
    )
  ).rows;
  const oppRows = (await db.client.query<{ id: string }>('SELECT id FROM opportunities LIMIT 800'))
    .rows;

  await db.db.insert(sequences).values([
    { id: SEQ_A, name: 'Perf Onboarding', status: 'active' },
    { id: SEQ_B, name: 'Perf Renewal', status: 'active' },
  ]);

  const enrollmentRows: InferInsertModel<typeof sequenceEnrollments>[] = [];
  const enrollmentIds: string[] = [];
  contactRows.forEach((c, i) => {
    const id = randomUUID();
    enrollmentIds.push(id);
    enrollmentRows.push({
      id,
      sequenceId: i % 2 === 0 ? SEQ_A : SEQ_B,
      leadId: c.lead_id,
      contactId: c.id,
      state: i % 5 === 0 ? 'paused' : 'active',
    });
  });
  for (let i = 0; i < enrollmentRows.length; i += 500) {
    await db.db.insert(sequenceEnrollments).values(enrollmentRows.slice(i, i + 500));
  }

  const events: ActRow[] = [];
  const leadOfEnrollment = new Map<string, string>();
  enrollmentRows.forEach((e) => {
    if (e.id !== undefined) leadOfEnrollment.set(e.id, e.leadId);
  });
  // Sequence events attributed via enrollmentId.
  enrollmentIds.forEach((eid, i) => {
    const leadId = leadOfEnrollment.get(eid);
    if (leadId === undefined) return;
    events.push({
      id: randomUUID(),
      leadId,
      type: 'sequence_step_sent',
      occurredAt: OVERLAY_WHEN,
      payload: { enrollmentId: eid },
    });
    events.push({
      id: randomUUID(),
      leadId,
      type: 'sequence_step_sent',
      occurredAt: OVERLAY_WHEN,
      payload: { enrollmentId: eid },
    });
    if (i % 4 === 0) {
      events.push({
        id: randomUUID(),
        leadId,
        type: 'sequence_paused',
        occurredAt: OVERLAY_WHEN,
        payload: { enrollmentId: eid, reason: 'reply' },
      });
    }
    if (i % 9 === 0) {
      events.push({
        id: randomUUID(),
        leadId,
        type: 'sequence_finished',
        occurredAt: OVERLAY_WHEN,
        payload: { enrollmentId: eid },
      });
    }
  });
  // Stage-change events referencing fixture opportunities.
  oppRows.forEach((o, i) => {
    if (stageIds.length < 2) return;
    const from = stageIds[i % stageIds.length];
    const to = stageIds[(i + 1) % stageIds.length];
    events.push({
      id: randomUUID(),
      leadId: contactRows[i % contactRows.length]?.lead_id ?? contactRows[0]?.lead_id ?? '',
      type: 'opportunity_stage_changed',
      occurredAt: OVERLAY_WHEN,
      payload: { opportunityId: o.id, from, to },
    });
  });
  for (let i = 0; i < events.length; i += 500) {
    await db.db.insert(activities).values(events.slice(i, i + 500));
  }
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);
  await loadGoldenFixtures(ctx.db); // loader resolves fixtures/out/golden itself
  await seedOverlay(ctx);
  seeded = true;
}, 300_000);

afterAll(async () => {
  await ctx?.close();
});

describe('report perf on the 5k golden fixture (NON-AUTHORITATIVE, < 500ms bound)', () => {
  const RANGE = { from: '2025-12-01', to: '2026-06-01' } as const;

  test('activity (groupBy=user) is under budget', async () => {
    if (!seeded) return;
    const med = await timed('activity/user', () =>
      runActivityReport(ctx.db, { ...RANGE, groupBy: 'user', limit: 500 }),
    );
    expect(med).toBeLessThan(BUDGET_MS);
  });

  test('activity (groupBy=day) is under budget', async () => {
    if (!seeded) return;
    const med = await timed('activity/day', () =>
      runActivityReport(ctx.db, { ...RANGE, groupBy: 'day', limit: 500 }),
    );
    expect(med).toBeLessThan(BUDGET_MS);
  });

  test('funnel is under budget', async () => {
    if (!seeded) return;
    const med = await timed('funnel', () => runFunnelReport(ctx.db, { ...RANGE, limit: 500 }));
    expect(med).toBeLessThan(BUDGET_MS);
  });

  test('sequences is under budget', async () => {
    if (!seeded) return;
    const med = await timed('sequences', () =>
      runSequencesReport(ctx.db, { ...RANGE, limit: 500 }),
    );
    expect(med).toBeLessThan(BUDGET_MS);
  });
});
