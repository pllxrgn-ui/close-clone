import { http, HttpResponse } from 'msw';
import type { Opportunity } from '@switchboard/shared';
import {
  getOpportunity,
  listOpportunities,
  listStages,
  patchOpportunity,
} from '../data/store.ts';
import type { OpportunityPatch } from '../data/store.ts';

/*
 * Additive MSW handlers for the pipeline board. They implement the C7
 * `opportunities` resource as a real list + write surface, backed by this
 * feature's in-memory store, so drag/keyboard moves persist for the session.
 *
 * `GET /opportunities` with no `leadId` returns the board's keyset page; WITH a
 * `leadId` it returns undefined to fall through to the leads-detail handler,
 * which owns that per-lead read. So these MUST be registered BEFORE
 * `leadDetailHandlers` (see the task's routeWiring / this feature's tests use
 * `server.use`, which prepends). Shapes follow the C7 envelope + C8 error codes
 * exactly, so the same UI drives the real API later.
 */

const api = (path: string): string => `*/api/v1${path}`;
const OPP_STATUSES: ReadonlyArray<Opportunity['status']> = ['active', 'won', 'lost'];

function errorJson(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

// ── Keyset pagination (C7): opaque row-id cursor over a stable id sort ────────
function encodeCursor(id: string): string {
  return btoa(`k:${id}`);
}
function decodeCursor(cursor: string): string | null {
  try {
    const decoded = atob(cursor);
    return decoded.startsWith('k:') ? decoded.slice(2) : null;
  } catch {
    return null;
  }
}
function clampLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(n, 500);
}
function keysetPage(
  items: Opportunity[],
  params: URLSearchParams,
): { items: Opportunity[]; nextCursor?: string } {
  const limit = clampLimit(params.get('limit'));
  const cursor = params.get('cursor');
  let start = 0;
  if (cursor) {
    const afterId = decodeCursor(cursor);
    const idx = afterId ? items.findIndex((it) => it.id === afterId) : -1;
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = items.slice(start, start + limit);
  const last = slice[slice.length - 1];
  if (start + limit < items.length && last) {
    return { items: slice, nextCursor: encodeCursor(last.id) };
  }
  return { items: slice };
}

export const pipelineHandlers = [
  // GET /opportunity-stages — the board's columns.
  http.get(api('/opportunity-stages'), () => HttpResponse.json(listStages())),

  // GET /opportunities — the whole board (no leadId). A leadId query falls
  // through to the leads-detail handler.
  http.get(api('/opportunities'), ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get('leadId') !== null) return undefined;
    const all = listOpportunities().sort((a, b) => a.id.localeCompare(b.id));
    return HttpResponse.json(keysetPage(all, url.searchParams));
  }),

  // PATCH /opportunities/:id — move stage / set won-lost. The board's only write.
  http.patch(api('/opportunities/:id'), async ({ params, request }) => {
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Request body must be a JSON object');

    const patch: OpportunityPatch = {};
    if (body.stageId !== undefined) {
      if (typeof body.stageId !== 'string' || !listStages().some((s) => s.id === body.stageId)) {
        return errorJson(400, 'VALIDATION_FAILED', 'Unknown stageId');
      }
      patch.stageId = body.stageId;
    }
    if (body.status !== undefined) {
      if (!OPP_STATUSES.includes(body.status as Opportunity['status'])) {
        return errorJson(400, 'VALIDATION_FAILED', 'status must be active, won, or lost');
      }
      patch.status = body.status as Opportunity['status'];
    }
    if (patch.stageId === undefined && patch.status === undefined) {
      return errorJson(400, 'VALIDATION_FAILED', 'Provide stageId and/or status');
    }
    if (getOpportunity(String(params.id)) === undefined) {
      return errorJson(404, 'NOT_FOUND', 'Opportunity not found');
    }
    const updated = patchOpportunity(String(params.id), patch);
    return HttpResponse.json(updated);
  }),
];
