import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Opportunity, OpportunityStage } from '@switchboard/shared';
import {
  getOpportunity,
  listOpportunities,
  listStages,
  patchOpportunity,
  resetStore,
} from './store.ts';

function stage(id: string, label: string, sortOrder: number): OpportunityStage {
  return { id, label, sortOrder, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}
function opp(id: string, stageId: string): Opportunity {
  return {
    id,
    leadId: 'l1',
    contactId: null,
    valueCents: 100_00,
    currency: 'USD',
    stageId,
    confidence: 40,
    closeDate: '2026-08-01',
    ownerId: null,
    status: 'active',
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const STAGES = [stage('a', 'Discovery', 0), stage('b', 'Closed Won', 1)];

beforeEach(() => {
  resetStore({ opportunities: [opp('o1', 'a'), opp('o2', 'a')], stages: STAGES });
});
afterEach(() => {
  resetStore(); // restore the default fixture-derived seed for other suites
});

describe('store reads', () => {
  test('lists the seeded opportunities and stages', () => {
    expect(listOpportunities().map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(listStages().map((s) => s.id)).toEqual(['a', 'b']);
  });

  test('reads return copies — mutating them does not corrupt the store', () => {
    const rows = listOpportunities();
    rows[0]!.stageId = 'hacked';
    expect(getOpportunity('o1')?.stageId).toBe('a');
  });
});

describe('patchOpportunity', () => {
  test('moves a deal to a new stage and status, and the change persists', () => {
    const before = getOpportunity('o1');
    const updated = patchOpportunity('o1', { stageId: 'b', status: 'won' });
    expect(updated?.stageId).toBe('b');
    expect(updated?.status).toBe('won');
    expect(getOpportunity('o1')?.stageId).toBe('b');
    expect(getOpportunity('o1')?.status).toBe('won');
    expect(updated?.updatedAt).not.toBe(before?.updatedAt);
  });

  test('a partial patch touches only the given fields', () => {
    patchOpportunity('o2', { stageId: 'b' });
    const row = getOpportunity('o2');
    expect(row?.stageId).toBe('b');
    expect(row?.status).toBe('active'); // untouched
  });

  test('returns undefined for an unknown id and leaves the store unchanged', () => {
    expect(patchOpportunity('nope', { stageId: 'b' })).toBeUndefined();
    expect(listOpportunities().map((o) => o.id)).toEqual(['o1', 'o2']);
  });
});

describe('resetStore', () => {
  test('re-seeds from the default fixture when called with no argument', () => {
    resetStore();
    // The fixture-derived board has many deals across the five real stages.
    expect(listOpportunities().length).toBeGreaterThan(10);
    expect(listStages().length).toBe(5);
  });
});
