import type { Opportunity, OpportunityStage } from '@switchboard/shared';

/*
 * Stage geometry for the pipeline board.
 *
 * Columns are `opportunity_stages` ordered by `sortOrder`. Two of them are
 * *terminal* — the won/lost close columns — detected semantically from the label
 * (robust to renames like "Closed Won" / "Won" / "Deal Won"). A card's `status`
 * is a pure function of the stage it sits in: any terminal stage forces
 * won/lost, every other stage is active. This keeps the board coherent no matter
 * how a card arrived in a column (drag, bracket keys, or the W/L shortcuts).
 */

export type OppStatus = Opportunity['status'];
export type TerminalKind = 'won' | 'lost';

/** Stages ordered for display: sortOrder asc, label as a stable tiebreak. */
export function sortStages(stages: readonly OpportunityStage[]): OpportunityStage[] {
  return [...stages].sort((a, b) =>
    a.sortOrder === b.sortOrder ? a.label.localeCompare(b.label) : a.sortOrder - b.sortOrder,
  );
}

/** Whether a stage closes a deal, and how. `null` for ordinary funnel stages. */
export function terminalKind(stage: OpportunityStage): TerminalKind | null {
  if (/\bwon\b/i.test(stage.label)) return 'won';
  if (/\blost\b/i.test(stage.label)) return 'lost';
  return null;
}

/** The `status` a card must carry once it sits in `stage`. */
export function statusForStage(stage: OpportunityStage): OppStatus {
  return terminalKind(stage) ?? 'active';
}

/** First stage of the given terminal kind, in display order (`null` if none). */
export function terminalStage(
  stages: readonly OpportunityStage[],
  kind: TerminalKind,
): OpportunityStage | null {
  return sortStages(stages).find((stage) => terminalKind(stage) === kind) ?? null;
}

/**
 * The stage one step from `currentStageId` in display order. `dir` is -1 (prev)
 * or +1 (next). Returns `null` at the boundaries or when the current stage is
 * unknown — the caller treats `null` as "no move".
 */
export function adjacentStage(
  stages: readonly OpportunityStage[],
  currentStageId: string | null,
  dir: -1 | 1,
): OpportunityStage | null {
  const ordered = sortStages(stages);
  const index = ordered.findIndex((stage) => stage.id === currentStageId);
  if (index < 0) return null;
  return ordered[index + dir] ?? null;
}
