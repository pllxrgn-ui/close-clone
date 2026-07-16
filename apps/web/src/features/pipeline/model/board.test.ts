import { describe, expect, test } from 'vitest';
import type { Opportunity, OpportunityStage } from '@switchboard/shared';
import { buildBoard } from './board.ts';

function stage(id: string, label: string, sortOrder: number): OpportunityStage {
  return { id, label, sortOrder, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

function opp(id: string, partial: Partial<Opportunity>): Opportunity {
  return {
    id,
    leadId: 'l1',
    contactId: null,
    valueCents: partial.valueCents ?? 100_00,
    currency: partial.currency ?? 'USD',
    stageId: partial.stageId ?? null,
    confidence: partial.confidence ?? 50,
    closeDate: partial.closeDate ?? null,
    ownerId: null,
    status: partial.status ?? 'active',
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const STAGES = [
  stage('disc', 'Discovery', 0),
  stage('prop', 'Proposal', 1),
  stage('won', 'Closed Won', 2),
];

describe('buildBoard', () => {
  test('produces one column per stage in display order', () => {
    const board = buildBoard([], STAGES);
    expect(board.columns.map((c) => c.stage.id)).toEqual(['disc', 'prop', 'won']);
    expect(board.columns.map((c) => c.terminal)).toEqual([null, null, 'won']);
  });

  test('places cards in their stage, counts them, and sorts by value desc', () => {
    const board = buildBoard(
      [
        opp('small', { stageId: 'disc', valueCents: 10_00 }),
        opp('big', { stageId: 'disc', valueCents: 90_00 }),
        opp('mid', { stageId: 'prop', valueCents: 50_00 }),
      ],
      STAGES,
    );
    const disc = board.columns[0]!;
    expect(disc.count).toBe(2);
    expect(disc.cards.map((c) => c.id)).toEqual(['big', 'small']);
    expect(board.columns[1]!.count).toBe(1);
    expect(board.columns[2]!.count).toBe(0);
  });

  test('subtotals are grouped per currency inside each column', () => {
    const board = buildBoard(
      [
        opp('a', { stageId: 'disc', valueCents: 100_00, currency: 'USD' }),
        opp('b', { stageId: 'disc', valueCents: 200_00, currency: 'EUR' }),
        opp('c', { stageId: 'disc', valueCents: 50_00, currency: 'USD' }),
      ],
      STAGES,
    );
    expect(board.columns[0]!.sums).toEqual([
      { currency: 'EUR', cents: 200_00 },
      { currency: 'USD', cents: 150_00 },
    ]);
  });

  test('open-pipeline totals span the active columns only, per currency', () => {
    const board = buildBoard(
      [
        opp('a', { stageId: 'disc', valueCents: 100_00, currency: 'USD', confidence: 50 }),
        opp('b', { stageId: 'prop', valueCents: 100_00, currency: 'EUR', confidence: 25 }),
        // A won deal is realized, not pipeline — excluded from the header totals.
        opp('c', { stageId: 'won', valueCents: 100_00, currency: 'USD', confidence: 100 }),
      ],
      STAGES,
    );
    expect(board.totals).toEqual([
      { currency: 'EUR', cents: 100_00 },
      { currency: 'USD', cents: 100_00 },
    ]);
    expect(board.weightedTotals).toEqual([
      { currency: 'EUR', cents: 25_00 }, // 25% of 100
      { currency: 'USD', cents: 50_00 }, // 50% of 100 (won deal excluded)
    ]);
    // The won column still reports its own realized subtotal.
    expect(board.columns[2]!.sums).toEqual([{ currency: 'USD', cents: 100_00 }]);
  });

  test('empty columns have zero count and no subtotals', () => {
    const board = buildBoard([], STAGES);
    expect(board.columns.every((c) => c.count === 0 && c.sums.length === 0)).toBe(true);
    expect(board.totals).toEqual([]);
  });

  test('cards with a null or unknown stage are excluded from the board and totals', () => {
    const board = buildBoard(
      [
        opp('orphan', { stageId: null, valueCents: 999_00 }),
        opp('ghost', { stageId: 'deleted-stage', valueCents: 999_00 }),
        opp('real', { stageId: 'disc', valueCents: 10_00 }),
      ],
      STAGES,
    );
    expect(board.columns.reduce((n, c) => n + c.count, 0)).toBe(1);
    expect(board.totals).toEqual([{ currency: 'USD', cents: 10_00 }]);
  });
});
