/**
 * Global search (Task 1e, CONTRACTS §C7). FTS + trigram over leads/contacts,
 * exposed as a ranked, keyset-paginated service consumed by the REST search
 * route (`GET /api/v1/search`).
 */
export {
  SearchService,
  InvalidCursorError,
  MIN_QUERY_LENGTH,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type SearchResult,
  type SearchResultType,
  type SearchPage,
  type SearchOptions,
} from './search.ts';
