import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { InferInsertModel } from 'drizzle-orm';

import { activities, leads, opportunities, opportunityStages, users } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { runFunnelReport } from './funnel.ts';
import { funnelStageRowSchema, type FunnelQuery, type FunnelStageRow } from './schemas.ts';

/**
 * Task 4g — funnel report, exact numbers on seeded data (D-009). Covers
 * currency isolation (no cross-currency summing), open/won/lost splits,
 * confidence-weighted value, close-date range scoping, stage-conversion
 * entered/exited from opportunity_stage_changed events, and the
 * lost-then-reopened opportunity edge (now active → counts as open, never lost).
 */

const USER = '00000000-0000-4000-8000-00000000000a';
const LEAD = '11111111-0000-4000-8000-000000000001';
const S_DISC = '22222222-0000-4000-8000-0000000000d1';
const S_PROP = '22222222-0000-4000-8000-0000000000d2';
const S_CLOSED = '22222222-0000-4000-8000-0000000000d3';

// Opportunity ids referenced by stage-change events.
const U_D1 = '33333333-0000-4000-8000-000000000001';
const E_D1 = '33333333-0000-4000-8000-000000000010';

type OppRow = InferInsertModel<typeof opportunities>;

let ctx: TestDb;

function opp(over: Partial<OppRow> & Pick<OppRow, 'currency' | 'stageId' | 'status'>): OppRow {
  return {
    id: over.id ?? randomUUID(),
    leadId: LEAD,
    valueCents: over.valueCents ?? 0,
    confidence: over.confidence ?? 0,
    ...over,
  };
}

function stageChange(opportunityId: string, from: string, to: string, occurredAt: string) {
  return {
    id: randomUUID(),
    leadId: LEAD,
    userId: USER,
    type: 'opportunity_stage_changed' as const,
    occurredAt,
    payload: { opportunityId, from, to },
  };
}

function rangedQuery(over: Partial<FunnelQuery> = {}): FunnelQuery {
  return { from: '2026-03-01', to: '2026-03-31', ...over };
}

function byKey(rows: FunnelStageRow[], currency: string, stageId: string): FunnelStageRow {
  const found = rows.find((r) => r.currency === currency && r.stageId === stageId);
  if (found === undefined) throw new Error(`no row for ${currency}/${stageId}`);
  return found;
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);

  await ctx.db
    .insert(users)
    .values([{ id: USER, email: 'a@example.com', name: 'Rep A', role: 'rep', idpSubject: 'idp|a' }]);
  await ctx.db.insert(leads).values([{ id: LEAD, name: 'Acme', ownerId: USER }]);
  await ctx.db.insert(opportunityStages).values([
    { id: S_DISC, label: 'Discovery', sortOrder: 0 },
    { id: S_PROP, label: 'Proposal', sortOrder: 1 },
    { id: S_CLOSED, label: 'Closed', sortOrder: 2 },
  ]);

  await ctx.db.insert(opportunities).values([
    // USD — Discovery (all active; U_REOPEN was lost then reopened → active now).
    opp({ id: U_D1, currency: 'USD', stageId: S_DISC, status: 'active', valueCents: 100000, confidence: 50 }),
    opp({ currency: 'USD', stageId: S_DISC, status: 'active', valueCents: 200000, confidence: 25 }),
    opp({
      currency: 'USD',
      stageId: S_DISC,
      status: 'active',
      valueCents: 111000,
      confidence: 100,
      closeDate: '2026-03-11', // close date set from its earlier lost life; status is active
    }),
    // USD — Proposal.
    opp({ currency: 'USD', stageId: S_PROP, status: 'active', valueCents: 500000, confidence: 40 }),
    opp({ currency: 'USD', stageId: S_PROP, status: 'won', valueCents: 300000, confidence: 100, closeDate: '2026-03-10' }),
    opp({ currency: 'USD', stageId: S_PROP, status: 'lost', valueCents: 150000, confidence: 0, closeDate: '2026-03-12' }),
    opp({ currency: 'USD', stageId: S_PROP, status: 'won', valueCents: 700000, confidence: 100, closeDate: '2026-05-01' }), // out of range
    // USD — Closed.
    opp({ currency: 'USD', stageId: S_CLOSED, status: 'won', valueCents: 400000, confidence: 100, closeDate: '2026-03-20' }),
    // EUR — separate currency universe.
    opp({ id: E_D1, currency: 'EUR', stageId: S_DISC, status: 'active', valueCents: 900000, confidence: 10 }),
    opp({ currency: 'EUR', stageId: S_PROP, status: 'lost', valueCents: 250000, confidence: 0, closeDate: '2026-03-15' }),
  ]);

  await ctx.db.insert(activities).values([
    stageChange(U_D1, S_DISC, S_PROP, '2026-03-05T10:00:00.000Z'),
    stageChange(U_D1, S_PROP, S_CLOSED, '2026-03-18T10:00:00.000Z'),
    stageChange(E_D1, S_DISC, S_PROP, '2026-03-08T10:00:00.000Z'),
    stageChange(U_D1, S_DISC, S_PROP, '2026-02-01T10:00:00.000Z'), // out of range
  ]);
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

describe('funnel — ranged, all currencies', () => {
  test('produces the exact (currency, stage) grid, currencies never summed', async () => {
    const page = await runFunnelReport(ctx.db, rangedQuery());
    // Ordered EUR before USD; within a currency by stage sort_order.
    expect(page.items.map((r) => `${r.currency}/${r.stageLabel}`)).toEqual([
      'EUR/Discovery',
      'EUR/Proposal',
      'USD/Discovery',
      'USD/Proposal',
      'USD/Closed',
    ]);

    expect(funnelStageRowSchema.parse(page.items[0])).toEqual(page.items[0]);

    expect(byKey(page.items, 'EUR', S_DISC)).toMatchObject({
      openCount: 1,
      openValueCents: 900000,
      openWeightedValueCents: 90000,
      wonCount: 0,
      lostCount: 0,
      enteredCount: 0,
      exitedCount: 1,
    });
    expect(byKey(page.items, 'EUR', S_PROP)).toMatchObject({
      openCount: 0,
      wonCount: 0,
      lostCount: 1,
      lostValueCents: 250000,
      enteredCount: 1,
      exitedCount: 0,
    });
    expect(byKey(page.items, 'USD', S_DISC)).toMatchObject({
      openCount: 3, // includes the reopened opp
      openValueCents: 411000,
      openWeightedValueCents: 211000,
      wonCount: 0,
      lostCount: 0, // reopened opp is active despite an in-range close_date
      enteredCount: 0,
      exitedCount: 1,
    });
    expect(byKey(page.items, 'USD', S_PROP)).toMatchObject({
      openCount: 1,
      openValueCents: 500000,
      openWeightedValueCents: 200000,
      wonCount: 1, // the out-of-range won is excluded
      wonValueCents: 300000,
      lostCount: 1,
      lostValueCents: 150000,
      enteredCount: 1,
      exitedCount: 1,
    });
    expect(byKey(page.items, 'USD', S_CLOSED)).toMatchObject({
      openCount: 0,
      wonCount: 1,
      wonValueCents: 400000,
      enteredCount: 1,
      exitedCount: 0,
    });
  });

  test('currency filter isolates a single currency', async () => {
    const page = await runFunnelReport(ctx.db, rangedQuery({ currency: 'USD' }));
    expect(new Set(page.items.map((r) => r.currency))).toEqual(new Set(['USD']));
    expect(page.items).toHaveLength(3);
  });
});

describe('funnel — all-time (no range)', () => {
  test('won/lost and conversions include out-of-range rows', async () => {
    const page = await runFunnelReport(ctx.db, {});
    const usdProp = byKey(page.items, 'USD', S_PROP);
    expect(usdProp.wonCount).toBe(2); // in-range + out-of-range won
    expect(usdProp.wonValueCents).toBe(1_000_000);
    expect(usdProp.lostCount).toBe(1);
    expect(usdProp.enteredCount).toBe(2); // both Disc→Proposal events
  });
});

describe('funnel — pagination + edges', () => {
  test('keyset pages walk the grid disjointly and in order', async () => {
    const p1 = await runFunnelReport(ctx.db, rangedQuery({ limit: 2 }));
    expect(p1.items).toHaveLength(2);
    expect(typeof p1.nextCursor).toBe('string');
    const cursor = p1.nextCursor;
    if (cursor === undefined) throw new Error('expected cursor');

    const p2 = await runFunnelReport(ctx.db, rangedQuery({ limit: 2, cursor }));
    const keys1 = p1.items.map((r) => `${r.currency}/${r.stageId}`);
    const keys2 = p2.items.map((r) => `${r.currency}/${r.stageId}`);
    expect(keys1.filter((k) => keys2.includes(k))).toEqual([]);
    expect(p2.items[0]?.stageLabel).toBe('Discovery'); // USD/Discovery follows the two EUR rows
    expect(p2.items[0]?.currency).toBe('USD');
  });

  test('an out-of-window range zeroes won/lost/conversions but keeps the open snapshot', async () => {
    const page = await runFunnelReport(ctx.db, { from: '2020-01-01', to: '2020-12-31' });
    // Open pipeline is a current snapshot (range-independent), so rows still
    // exist; range-scoped metrics (won/lost by close_date, conversions) are zero.
    expect(page.items.length).toBeGreaterThan(0);
    for (const row of page.items) {
      expect(row.wonCount).toBe(0);
      expect(row.lostCount).toBe(0);
      expect(row.enteredCount).toBe(0);
      expect(row.exitedCount).toBe(0);
    }
  });
});
