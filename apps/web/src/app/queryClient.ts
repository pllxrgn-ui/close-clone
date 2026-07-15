import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/errors.ts';

/*
 * TanStack Query defaults tuned for a data-dense pro tool:
 *  - a short staleTime so lists feel live without hammering the API
 *  - no refetch-on-focus thrash (WS invalidation hints drive freshness later)
 *  - never retry 4xx (client errors won't fix themselves); retry 5xx twice
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}
