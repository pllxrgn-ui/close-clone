import type { Opportunity, OpportunityStage } from '@switchboard/shared';
import { apiRequest } from '../../../api/client.ts';
import type { Page } from '../../../api/client.ts';

/*
 * Typed client for the pipeline board. Reads follow the C7 keyset envelope; the
 * board needs every open + closed deal to compute column and pipeline totals, so
 * `fetchAllOpportunities` drains the cursor. The single write is a PATCH that
 * carries the new stage and the status implied by it.
 */

const OPPORTUNITIES_PAGE = 200;

/** All opportunities, following keyset pagination to completion. */
export async function fetchAllOpportunities(signal?: AbortSignal): Promise<Opportunity[]> {
  const out: Opportunity[] = [];
  let cursor: string | undefined;
  do {
    const query: Record<string, string | number | undefined> = { limit: OPPORTUNITIES_PAGE };
    if (cursor !== undefined) query.cursor = cursor;
    const page = await apiRequest<Page<Opportunity>>('/opportunities', {
      query,
      ...(signal ? { signal } : {}),
    });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

export function listOpportunityStages(signal?: AbortSignal): Promise<OpportunityStage[]> {
  return apiRequest<OpportunityStage[]>('/opportunity-stages', { ...(signal ? { signal } : {}) });
}

export interface MoveOpportunityInput {
  stageId: string;
  status: Opportunity['status'];
}

/** Move a deal to a new stage (and the status that stage implies). */
export function moveOpportunity(
  id: string,
  input: MoveOpportunityInput,
  signal?: AbortSignal,
): Promise<Opportunity> {
  return apiRequest<Opportunity>(`/opportunities/${id}`, {
    method: 'PATCH',
    body: input,
    ...(signal ? { signal } : {}),
  });
}
