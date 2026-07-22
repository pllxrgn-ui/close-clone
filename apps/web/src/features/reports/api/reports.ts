/*
 * Typed client for the reporting endpoints (C7). Thin wrappers over the shared
 * fetch client — the same calls hit the MSW mock (MOCK_MODE) or the real API,
 * because the request/response shapes are identical (see types.ts).
 */
import { apiRequest } from '../../../api/client.ts';
import type { Page } from '../../../api/client.ts';
import type {
  ActivityQuery,
  ActivityReportRow,
  FunnelQuery,
  FunnelStageRow,
  SequenceReportRow,
  SequencesQuery,
} from '../types.ts';

export function fetchActivityReport(
  query: ActivityQuery,
  signal?: AbortSignal,
): Promise<Page<ActivityReportRow>> {
  return apiRequest<Page<ActivityReportRow>>('/reports/activity', {
    query: {
      from: query.from,
      to: query.to,
      userId: query.userId,
      groupBy: query.groupBy,
      limit: query.limit,
      cursor: query.cursor,
    },
    ...(signal ? { signal } : {}),
  });
}

export function fetchFunnelReport(
  query: FunnelQuery = {},
  signal?: AbortSignal,
): Promise<Page<FunnelStageRow>> {
  return apiRequest<Page<FunnelStageRow>>('/reports/funnel', {
    query: {
      from: query.from,
      to: query.to,
      currency: query.currency,
      limit: query.limit,
      cursor: query.cursor,
    },
    ...(signal ? { signal } : {}),
  });
}

export function fetchSequencesReport(
  query: SequencesQuery = {},
  signal?: AbortSignal,
): Promise<Page<SequenceReportRow>> {
  return apiRequest<Page<SequenceReportRow>>('/reports/sequences', {
    query: {
      sequenceId: query.sequenceId,
      from: query.from,
      to: query.to,
      limit: query.limit,
      cursor: query.cursor,
    },
    ...(signal ? { signal } : {}),
  });
}

async function fetchAllPages<TQuery extends { cursor?: string; limit?: number }, TRow>(
  fetchPage: (query: TQuery, signal?: AbortSignal) => Promise<Page<TRow>>,
  query: TQuery,
  signal?: AbortSignal,
): Promise<Page<TRow>> {
  const items: TRow[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await fetchPage({ ...query, limit: 500, cursor } as TQuery, signal);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined && seen.has(cursor)) throw new Error('report cursor repeated');
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor !== undefined);
  return { items };
}

export const fetchCompleteActivityReport = (
  query: ActivityQuery,
  signal?: AbortSignal,
): Promise<Page<ActivityReportRow>> => fetchAllPages(fetchActivityReport, query, signal);

export const fetchCompleteFunnelReport = (
  query: FunnelQuery = {},
  signal?: AbortSignal,
): Promise<Page<FunnelStageRow>> => fetchAllPages(fetchFunnelReport, query, signal);

export const fetchCompleteSequencesReport = (
  query: SequencesQuery = {},
  signal?: AbortSignal,
): Promise<Page<SequenceReportRow>> => fetchAllPages(fetchSequencesReport, query, signal);
