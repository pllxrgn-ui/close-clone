import { apiRequest } from './client.ts';
import type { SearchResponse } from './types.ts';

/** GET /search?q= — global FTS across leads/contacts/opportunities. */
export function search(q: string, signal?: AbortSignal): Promise<SearchResponse> {
  return apiRequest<SearchResponse>(
    '/search',
    signal ? { query: { q }, signal } : { query: { q } },
  );
}
