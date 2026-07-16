/*
 * MSW handlers for the reporting read surface (S4). Shapes match CONTRACTS §C7
 * and the real API (apps/api/src/services/reports): `/api/v1/reports/*`,
 * camelCase JSON, `{error:{code,message}}` bodies (§C8), keyset
 * `{items,nextCursor?}` pagination. Rows are recomputed from the deterministic
 * report seed on every request, so a date-range change genuinely re-queries.
 *
 * Registered at merge by spreading `reportsHandlers` into the worker/server
 * handler arrays (see routeWiring), and via `server.use` in this feature's tests.
 */
import { http, HttpResponse } from 'msw';
import type { Page } from '../../../api/client.ts';
import { aggregateActivity, aggregateFunnel, aggregateSequences } from './aggregate.ts';
import { reportSeed } from './seed.ts';
import { ReportRangeError } from '../lib/range.ts';
import type { ActivityGroupBy } from '../types.ts';

const api = (path: string): string => `*/api/v1${path}`;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function errorJson(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

function clampLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function encodeCursor(id: string): string {
  return btoa(`r:${id}`);
}
function decodeCursor(cursor: string): string | null {
  try {
    const decoded = atob(cursor);
    return decoded.startsWith('r:') ? decoded.slice(2) : null;
  } catch {
    return null;
  }
}

/** Keyset page over pre-sorted, unique-identity rows (opaque row-identity cursor). */
function pageRows<T>(rows: T[], params: URLSearchParams, idOf: (row: T) => string): Page<T> {
  const limit = clampLimit(params.get('limit'));
  const cursor = params.get('cursor');
  let start = 0;
  if (cursor) {
    const afterId = decodeCursor(cursor);
    const idx = afterId ? rows.findIndex((r) => idOf(r) === afterId) : -1;
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  const last = slice[slice.length - 1];
  if (hasMore && last) return { items: slice, nextCursor: encodeCursor(idOf(last)) };
  return { items: slice };
}

/** Map a thrown range error to VALIDATION_FAILED (§C8); rethrow anything else. */
function rangeError(err: unknown): ReturnType<typeof errorJson> | null {
  if (err instanceof ReportRangeError) return errorJson(400, 'VALIDATION_FAILED', err.message);
  return null;
}

export const reportsHandlers = [
  // ── GET /reports/activity ─────────────────────────────────────────────────
  http.get(api('/reports/activity'), ({ request }) => {
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!from || !to) {
      return errorJson(400, 'VALIDATION_FAILED', '`from` and `to` are required');
    }
    const groupByRaw = url.searchParams.get('groupBy') ?? 'user';
    if (groupByRaw !== 'user' && groupByRaw !== 'day') {
      return errorJson(400, 'VALIDATION_FAILED', '`groupBy` must be "user" or "day"');
    }
    const groupBy: ActivityGroupBy = groupByRaw;
    const userId = url.searchParams.get('userId');
    try {
      const rows = aggregateActivity({
        events: reportSeed.activityEvents,
        calls: reportSeed.calls,
        reps: reportSeed.reps,
        from,
        to,
        groupBy,
        ...(userId ? { userId } : {}),
      });
      return HttpResponse.json(pageRows(rows, url.searchParams, (r) => r.bucket));
    } catch (err) {
      const mapped = rangeError(err);
      if (mapped) return mapped;
      throw err;
    }
  }),

  // ── GET /reports/funnel ───────────────────────────────────────────────────
  http.get(api('/reports/funnel'), ({ request }) => {
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if ((from === null) !== (to === null)) {
      return errorJson(400, 'VALIDATION_FAILED', '`from` and `to` must be provided together');
    }
    const currency = url.searchParams.get('currency');
    if (currency !== null && currency.trim().length !== 3) {
      return errorJson(400, 'VALIDATION_FAILED', '`currency` must be a 3-letter code');
    }
    try {
      const rows = aggregateFunnel({
        opps: reportSeed.funnelOpps,
        stageChanges: reportSeed.stageChanges,
        stages: reportSeed.stages,
        ...(from && to ? { from, to } : {}),
        ...(currency ? { currency: currency.toUpperCase() } : {}),
      });
      return HttpResponse.json(
        pageRows(rows, url.searchParams, (r) => `${r.currency}::${r.stageId}`),
      );
    } catch (err) {
      const mapped = rangeError(err);
      if (mapped) return mapped;
      throw err;
    }
  }),

  // ── GET /reports/sequences ────────────────────────────────────────────────
  http.get(api('/reports/sequences'), ({ request }) => {
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if ((from === null) !== (to === null)) {
      return errorJson(400, 'VALIDATION_FAILED', '`from` and `to` must be provided together');
    }
    const sequenceId = url.searchParams.get('sequenceId');
    try {
      const rows = aggregateSequences({
        sequences: reportSeed.sequences,
        enrollments: reportSeed.enrollments,
        events: reportSeed.sequenceEvents,
        ...(from && to ? { from, to } : {}),
        ...(sequenceId ? { sequenceId } : {}),
      });
      return HttpResponse.json(
        pageRows(rows, url.searchParams, (r) => `${r.sequenceName}::${r.sequenceId}`),
      );
    } catch (err) {
      const mapped = rangeError(err);
      if (mapped) return mapped;
      throw err;
    }
  }),
];
