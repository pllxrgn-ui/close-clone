import { queryOptions } from '@tanstack/react-query';
import { listLeadStatuses, listOpportunityStages, listUsers } from './reference.ts';

/*
 * Canonical query options for org-wide reference data. Every feature that
 * needs users / lead statuses / opportunity stages spreads one of these into
 * useQuery, so the whole app shares a single cache entry (and a single
 * invalidation point) per resource under the ['ref', …] namespace — instead of
 * the four divergent keys the audit found refetching /users per feature.
 * These lists are org-configuration: change rarely, so a long staleTime keeps
 * cross-feature navigation from refetching them.
 */

const REF_STALE_MS = 5 * 60_000;

export const usersQuery = () =>
  queryOptions({
    queryKey: ['ref', 'users'] as const,
    queryFn: () => listUsers(),
    staleTime: REF_STALE_MS,
  });

export const leadStatusesQuery = () =>
  queryOptions({
    queryKey: ['ref', 'lead-statuses'] as const,
    queryFn: () => listLeadStatuses(),
    staleTime: REF_STALE_MS,
  });

export const opportunityStagesQuery = () =>
  queryOptions({
    queryKey: ['ref', 'opportunity-stages'] as const,
    queryFn: () => listOpportunityStages(),
    staleTime: REF_STALE_MS,
  });
