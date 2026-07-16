import type { Opportunity, OpportunityStage } from '@switchboard/shared';
import { sortStages, terminalKind } from '../lib/stages.ts';
import type { TerminalKind } from '../lib/stages.ts';
import { sumByCurrency, weightedByCurrency } from '../lib/money.ts';
import type { CurrencySum } from '../lib/money.ts';

/*
 * The pure board view-model: opportunities grouped into stage columns, each with
 * its own per-currency subtotals, plus board-wide totals. No React, no store —
 * given the same inputs it always produces the same board, which is what the
 * "sums recompute after a move" and "currency separation" assertions verify.
 */

export interface ColumnVM {
  stage: OpportunityStage;
  terminal: TerminalKind | null;
  cards: Opportunity[];
  count: number;
  /** Total value per currency in this column. */
  sums: CurrencySum[];
  /** Confidence-weighted value per currency in this column. */
  weighted: CurrencySum[];
}

export interface BoardVM {
  columns: ColumnVM[];
  /** Open pipeline per currency — active (non-terminal) columns only. */
  totals: CurrencySum[];
  /** Confidence-weighted open pipeline per currency. */
  weightedTotals: CurrencySum[];
}

/** Cards within a column: largest deal first, id as a stable tiebreak. */
function sortCards(cards: Opportunity[]): Opportunity[] {
  return [...cards].sort((a, b) =>
    a.valueCents === b.valueCents ? a.id.localeCompare(b.id) : b.valueCents - a.valueCents,
  );
}

/**
 * Build the board. Opportunities whose `stageId` is null or unknown are not
 * placed in any column and are excluded from every total — the board only ever
 * reflects deals that live in a real stage.
 */
export function buildBoard(
  opps: readonly Opportunity[],
  stages: readonly OpportunityStage[],
): BoardVM {
  const ordered = sortStages(stages);
  const byStage = new Map<string, Opportunity[]>();
  for (const stage of ordered) byStage.set(stage.id, []);

  for (const opp of opps) {
    const bucket = opp.stageId !== null ? byStage.get(opp.stageId) : undefined;
    if (bucket) bucket.push(opp);
  }

  const columns: ColumnVM[] = ordered.map((stage) => {
    const cards = sortCards(byStage.get(stage.id) ?? []);
    return {
      stage,
      terminal: terminalKind(stage),
      cards,
      count: cards.length,
      sums: sumByCurrency(cards),
      weighted: weightedByCurrency(cards),
    };
  });

  // "Pipeline" is open money: closed-won/closed-lost columns are realized, not
  // pipeline, so the header totals exclude them (their value still shows in the
  // column header). Moving a deal into a terminal column visibly drops the
  // open-pipeline figure — the recompute the demo leans on.
  const openCards = columns
    .filter((column) => column.terminal === null)
    .flatMap((column) => column.cards);
  return {
    columns,
    totals: sumByCurrency(openCards),
    weightedTotals: weightedByCurrency(openCards),
  };
}
