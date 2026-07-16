import type { Opportunity, OpportunityStage } from '@switchboard/shared';
import { buildPipelineSeed } from './seed.ts';

/*
 * The board's in-memory demo database.
 *
 * Module-scope state seeded from the fixture. Writes (stage moves, won/lost)
 * mutate it in place, so lists and column sums visibly change and survive route
 * changes within a session — while a full reload re-seeds from scratch. The MSW
 * handlers are the only real caller; tests use `resetStore` for isolation and to
 * inject a small controlled seed. Reads and writes return copies so no consumer
 * can reach in and mutate stored rows behind the store's back.
 */

export interface StoreSeed {
  opportunities?: Opportunity[];
  stages?: OpportunityStage[];
}

interface StoreState {
  opportunities: Map<string, Opportunity>;
  stages: OpportunityStage[];
}

function build(seed?: StoreSeed): StoreState {
  const base = buildPipelineSeed();
  const opportunities = seed?.opportunities ?? base.opportunities;
  const stages = seed?.stages ?? base.stages;
  return {
    opportunities: new Map(opportunities.map((opp) => [opp.id, { ...opp }])),
    stages: stages.map((stage) => ({ ...stage })),
  };
}

let state = build();

/** Reset to the default seed, or to a caller-supplied one (tests). */
export function resetStore(seed?: StoreSeed): void {
  state = build(seed);
}

export function listStages(): OpportunityStage[] {
  return state.stages.map((stage) => ({ ...stage }));
}

export function listOpportunities(): Opportunity[] {
  return [...state.opportunities.values()].map((opp) => ({ ...opp }));
}

export function getOpportunity(id: string): Opportunity | undefined {
  const found = state.opportunities.get(id);
  return found ? { ...found } : undefined;
}

export interface OpportunityPatch {
  stageId?: string;
  status?: Opportunity['status'];
}

/** Apply a stage/status patch. Returns the updated row, or undefined if absent. */
export function patchOpportunity(id: string, patch: OpportunityPatch): Opportunity | undefined {
  const current = state.opportunities.get(id);
  if (!current) return undefined;
  const next: Opportunity = {
    ...current,
    ...(patch.stageId !== undefined ? { stageId: patch.stageId } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updatedAt: new Date().toISOString(),
  };
  state.opportunities.set(id, next);
  return { ...next };
}
