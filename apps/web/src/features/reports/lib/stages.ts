/*
 * Funnel stage classification. The API's funnel row carries no won/lost flag
 * (CONTRACTS §C1 has no such column), so the terminal columns are inferred from
 * the stage label — the same rule the seed uses to build the population, kept
 * here (pure, mock-free) so both the seed and the UI share one source of truth.
 */

export type StageKind = 'open' | 'won' | 'lost';

/** `won` / `lost` for the two terminal stages, else `open`. */
export function stageKind(label: string): StageKind {
  if (/won/i.test(label)) return 'won';
  if (/lost/i.test(label)) return 'lost';
  return 'open';
}
