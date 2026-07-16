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
