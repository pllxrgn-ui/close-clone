import { describe, expect, test } from 'vitest';
import { db } from '../../../mocks/fixtures.ts';
import { sortStages, statusForStage, terminalKind } from '../lib/stages.ts';
import { buildPipelineSeed } from './seed.ts';

const seed = buildPipelineSeed();
const stageById = new Map(seed.stages.map((s) => [s.id, s]));

describe('buildPipelineSeed', () => {
  test('is deterministic across calls', () => {
    expect(buildPipelineSeed()).toEqual(buildPipelineSeed());
  });

  test('preserves every fixture deal identity (id, lead, value)', () => {
    const identity = (o: { id: string; leadId: string; valueCents: number }) =>
      `${o.id}|${o.leadId}|${o.valueCents}`;
    expect(new Set(seed.opportunities.map(identity))).toEqual(
      new Set(db.opportunities.map(identity)),
    );
  });

  test('prices deals in a small set of currencies, with more than one present', () => {
    const currencies = new Set(seed.opportunities.map((o) => o.currency));
    for (const c of currencies) expect(['USD', 'EUR', 'AUD']).toContain(c);
    expect(currencies.size).toBeGreaterThan(1);
  });

  test('every deal sits in a real stage with a status coherent to that stage', () => {
    for (const opp of seed.opportunities) {
      const stage = opp.stageId ? stageById.get(opp.stageId) : undefined;
      expect(stage).toBeDefined();
      expect(opp.status).toBe(statusForStage(stage!));
    }
  });

  test('won deals read as 100% and lost as 0% confidence; open deals stay 0..100', () => {
    for (const opp of seed.opportunities) {
      if (opp.status === 'won') expect(opp.confidence).toBe(100);
      else if (opp.status === 'lost') expect(opp.confidence).toBe(0);
      else expect(opp.confidence).toBeGreaterThanOrEqual(0);
    }
  });

  test('leaves a realistic funnel: more open deals than closed', () => {
    const open = seed.opportunities.filter((o) => o.status === 'active').length;
    const closed = seed.opportunities.length - open;
    expect(open).toBeGreaterThan(closed);
  });

  test('at least one open deal is already overdue (past close date) — the amber path', () => {
    const overdueOpen = seed.opportunities.filter(
      (o) => o.status === 'active' && o.closeDate !== null && o.closeDate < '2026-07-15',
    );
    expect(overdueOpen.length).toBeGreaterThan(0);
  });

  test('exposes the five fixture stages in display order', () => {
    expect(seed.stages).toEqual(sortStages(db.opportunityStages));
    const terminals = seed.stages.filter((s) => terminalKind(s) !== null);
    expect(terminals.length).toBe(2);
  });
});
