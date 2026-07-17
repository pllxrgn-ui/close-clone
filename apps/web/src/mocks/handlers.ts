/*
 * MSW handlers — the mock REST surface. Shapes match CONTRACTS §C7 exactly:
 * `/api/v1` base, camelCase JSON, `{error:{code}}` bodies (C8), keyset
 * `{items,nextCursor?}` pagination. The same handler set backs the browser
 * worker (dev) and the node server (tests).
 */
import { http, HttpResponse } from 'msw';
import type { SmartView } from '@switchboard/shared';
import { parse, ParseError } from '@switchboard/shared';
import type { Page } from '../api/client.ts';
import type { SearchHit } from '../api/types.ts';
import { db } from './fixtures.ts';

const api = (path: string): string => `*/api/v1${path}`;

function errorJson(status: number, code: string, message: string, details?: unknown) {
  const body =
    details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  return HttpResponse.json(body, { status });
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

// ── Keyset pagination over a pre-sorted array (opaque row-identity cursor) ────
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
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 200);
}
function keysetPage<T extends { id: string }>(items: T[], searchParams: URLSearchParams): Page<T> {
  const limit = clampLimit(searchParams.get('limit'));
  const cursor = searchParams.get('cursor');
  let start = 0;
  if (cursor) {
    const afterId = decodeCursor(cursor);
    const idx = afterId ? items.findIndex((it) => it.id === afterId) : -1;
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = items.slice(start, start + limit);
  const hasMore = start + limit < items.length;
  const last = slice[slice.length - 1];
  if (hasMore && last) {
    return { items: slice, nextCursor: encodeCursor(last.id) };
  }
  return { items: slice };
}

type ParseOutcome = { ast: Record<string, unknown> } | { error: ReturnType<typeof errorJson> };
function tryParseDsl(dsl: string): ParseOutcome {
  try {
    return { ast: parse(dsl) as unknown as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ParseError) {
      return {
        error: errorJson(400, 'VALIDATION_FAILED', err.message, { position: err.position }),
      };
    }
    throw err;
  }
}

export const handlers = [
  // ── Auth (dev-login stub) + reference data ────────────────────────────────
  http.get(api('/auth/dev-users'), () => HttpResponse.json(db.users)),
  http.get(api('/users'), () => HttpResponse.json(db.users)),
  http.get(api('/lead-statuses'), () => HttpResponse.json(db.leadStatuses)),

  // ── Leads ─────────────────────────────────────────────────────────────────
  http.get(api('/leads/:id/timeline'), ({ params, request }) => {
    const events = db.activitiesByLead.get(String(params.id));
    if (!events) return errorJson(404, 'NOT_FOUND', 'Lead not found');
    const url = new URL(request.url);
    return HttpResponse.json(keysetPage(events, url.searchParams));
  }),
  http.get(api('/leads/:id'), ({ params }) => {
    const lead = db.leads.find((l) => l.id === String(params.id));
    if (!lead) return errorJson(404, 'NOT_FOUND', 'Lead not found');
    return HttpResponse.json(lead);
  }),
  http.get(api('/leads'), ({ request }) => {
    const url = new URL(request.url);
    const statusId = url.searchParams.get('statusId');
    const ownerId = url.searchParams.get('ownerId');
    const idsRaw = url.searchParams.get('ids');
    let items = db.leads;
    if (statusId) items = items.filter((l) => l.statusId === statusId);
    if (ownerId) items = items.filter((l) => l.ownerId === ownerId);
    // CONTRACTS 1.3.3: comma-separated batch id filter (label resolution).
    if (idsRaw) {
      const ids = new Set(idsRaw.split(','));
      items = items.filter((l) => ids.has(l.id));
    }
    return HttpResponse.json(keysetPage(items, url.searchParams));
  }),

  // ── Smart views (CRUD + preview) ──────────────────────────────────────────
  http.post(api('/smart-views/preview'), async ({ request }) => {
    const body = await readJson(request);
    if (!body || (body.dsl === undefined && body.ast === undefined)) {
      return errorJson(400, 'VALIDATION_FAILED', 'Provide dsl or ast');
    }
    if (typeof body.dsl === 'string') {
      const parsed = tryParseDsl(body.dsl);
      if ('error' in parsed) return parsed.error;
    }
    const items = db.leads.slice(0, 25);
    return HttpResponse.json({ items, countEstimate: db.leads.length });
  }),
  http.get(api('/smart-views'), () => HttpResponse.json(db.smartViews)),
  http.get(api('/smart-views/:id'), ({ params }) => {
    const view = db.smartViews.find((v) => v.id === String(params.id));
    if (!view) return errorJson(404, 'NOT_FOUND', 'Smart view not found');
    return HttpResponse.json(view);
  }),
  http.post(api('/smart-views'), async ({ request }) => {
    const body = await readJson(request);
    const name = body?.name;
    const dsl = body?.dsl;
    if (typeof name !== 'string' || typeof dsl !== 'string') {
      return errorJson(400, 'VALIDATION_FAILED', 'name and dsl are required');
    }
    const parsed = tryParseDsl(dsl);
    if ('error' in parsed) return parsed.error;
    const now = new Date().toISOString();
    const view: SmartView = {
      id: crypto.randomUUID(),
      name,
      ownerId: null,
      shared: body?.shared === true,
      dsl,
      ast: parsed.ast,
      sort: isRecord(body?.sort) ? body.sort : null,
      columns: Array.isArray(body?.columns) ? body.columns : null,
      createdAt: now,
      updatedAt: now,
    };
    db.smartViews.push(view);
    return HttpResponse.json(view, { status: 201 });
  }),
  http.patch(api('/smart-views/:id'), async ({ params, request }) => {
    const view = db.smartViews.find((v) => v.id === String(params.id));
    if (!view) return errorJson(404, 'NOT_FOUND', 'Smart view not found');
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');
    if (typeof body.name === 'string') view.name = body.name;
    if (typeof body.shared === 'boolean') view.shared = body.shared;
    if (typeof body.dsl === 'string') {
      const parsed = tryParseDsl(body.dsl);
      if ('error' in parsed) return parsed.error;
      view.dsl = body.dsl;
      view.ast = parsed.ast;
    }
    view.updatedAt = new Date().toISOString();
    return HttpResponse.json(view);
  }),
  http.delete(api('/smart-views/:id'), ({ params }) => {
    const idx = db.smartViews.findIndex((v) => v.id === String(params.id));
    if (idx < 0) return errorJson(404, 'NOT_FOUND', 'Smart view not found');
    db.smartViews.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // ── Global search ─────────────────────────────────────────────────────────
  http.get(api('/search'), ({ request }) => {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (!q) return errorJson(400, 'VALIDATION_FAILED', 'Query "q" is required');
    const items: SearchHit[] = db.searchIndex
      .filter(
        (h) =>
          h.title.toLowerCase().includes(q) ||
          (h.subtitle ? h.subtitle.toLowerCase().includes(q) : false),
      )
      .slice(0, 20);
    return HttpResponse.json({ items });
  }),
];
