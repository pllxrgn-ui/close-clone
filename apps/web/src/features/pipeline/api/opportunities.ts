import type { Lead, Opportunity } from '@switchboard/shared';
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

/** GET /leads?ids= batch cap — mirrors the route's MAX_LIMIT (CONTRACTS 1.3.3). */
const LEAD_IDS_BATCH = 200;

/**
 * Lead id → name for exactly the given ids, via the batch `GET /leads?ids=`
 * filter (CONTRACTS 1.3.3) — the board resolves names for its RENDERED cards
 * only, instead of the historical full-cursor drain of every lead in the org.
 * Batches of 200 fetch in parallel; ids the server no longer knows (deleted
 * leads) are simply absent and render the caller's 'Unknown lead' fallback.
 */
export async function fetchLeadNames(
  leadIds: Iterable<string>,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const ids = [...new Set(leadIds)];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += LEAD_IDS_BATCH) {
    batches.push(ids.slice(i, i + LEAD_IDS_BATCH));
  }
  const pages = await Promise.all(
    batches.map((batch) =>
      apiRequest<Page<Lead>>('/leads', {
        query: { ids: batch.join(','), limit: LEAD_IDS_BATCH },
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  for (const page of pages) {
    for (const lead of page.items) names.set(lead.id, lead.name);
  }
  return names;
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
