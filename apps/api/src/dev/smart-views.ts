import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  astSchema,
  compile,
  parse,
  ParseError,
  MAX_LIMIT as COMPILE_MAX_LIMIT,
  type Ast,
  type CompileContext,
  type CompileOptions,
  type Cursor as CompileCursor,
  type DslCustomFieldDef,
  type Position,
} from '@switchboard/shared';
import { z } from 'zod';

import { leads, smartViews, type Db } from '../db/index.ts';
import { sendError } from '../routes/http.ts';
import { LEAD_COLUMNS, mapLead } from './leads.ts';
import { decodeCursor, encodeCursor, resolveCurrentUserId, toIsoRequired } from './util.ts';

/**
 * Smart-view shims (DEV-ONLY). C7 defines `smart-views` (+ `POST
 * /smart-views/preview`) but no route plugin exists on this branch. This gives
 * the web CRUD-lite over the real `smart_views` table plus a preview that is the
 * genuine article: it runs the stored/submitted DSL through the SINGLE query
 * authority — `@switchboard/shared` `parse()` → `compile()` → SQL (C3, ARCH §1) —
 * and executes it against the fixture. No hand-written WHERE clause: the compiler
 * owns the query. Matches W1's MSW shapes (keyset items + `countEstimate`).
 */

// Minimal raw-SQL runner (the PGlite client); the compiler emits `$n` params.
export interface RawQueryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface SmartViewRouteDeps {
  db: Db;
  client: RawQueryable;
  sessionSecret: string;
  /** Fallback for `me` when there is no dev session (a real fixture owner id). */
  defaultUserId: string;
  /** Org timezone for relative-date resolution (C3). */
  orgTimezone: string;
}

// Empty custom-field catalog: the fixture exposes no catalogued custom fields,
// so `custom.<key>` predicates are (correctly) rejected at parse time here.
const FIELD_CATALOG: readonly DslCustomFieldDef[] = [];
const PREVIEW_DEFAULT_LIMIT = 25;
const PREVIEW_MAX_LIMIT = 100;
/** Sentinel that neutralises the compiled page LIMIT to get a true count. */
const COUNT_ALL = 1_000_000;

// Seed views mirror W1's fixture set so the demo opens on familiar saved views.
// Deterministic ids/timestamps keep every boot byte-identical (acceptance: no
// wall-clock in seeding).
const SEED_TS = '2026-01-01T00:00:00.000Z';
const SEED_VIEWS: ReadonlyArray<{ id: string; name: string; dsl: string; shared: boolean }> = [
  {
    id: '5e1d0000-0000-4000-8000-000000000001',
    name: 'My open leads',
    dsl: 'owner in (me) and status != "Won" and status != "Lost"',
    shared: false,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000002',
    name: 'Overdue follow-ups',
    dsl: 'next_task_due < today',
    shared: true,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000003',
    name: 'New replies (48h)',
    dsl: 'has inbound_email within 2 d',
    shared: true,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000004',
    name: 'In onboarding sequence',
    dsl: 'has in_sequence("Onboarding")',
    shared: true,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000005',
    name: 'Do not contact',
    dsl: 'dnc = true',
    shared: true,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000006',
    name: 'High-value opportunities',
    dsl: 'opportunity.value > 5000',
    shared: false,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000007',
    name: 'Recently contacted',
    dsl: 'last_contacted > 7 d ago',
    shared: false,
  },
];

/** Seed the smart_views table with the demo views (idempotent). */
export async function seedDevSmartViews(db: Db): Promise<void> {
  const rows = SEED_VIEWS.map((s) => ({
    id: s.id,
    name: s.name,
    ownerId: null,
    shared: s.shared,
    dsl: s.dsl,
    ast: parse(s.dsl, { fieldCatalog: FIELD_CATALOG }) as unknown as Record<string, unknown>,
    sort: { field: 'last_contacted', dir: 'desc' } as Record<string, unknown>,
    columns: ['name', 'status', 'owner', 'last_contacted', 'next_task_due'] as unknown[],
    createdAt: SEED_TS,
    updatedAt: SEED_TS,
  }));
  await db.insert(smartViews).values(rows).onConflictDoNothing();
}

const SMARTVIEW_COLUMNS = {
  id: smartViews.id,
  name: smartViews.name,
  ownerId: smartViews.ownerId,
  shared: smartViews.shared,
  dsl: smartViews.dsl,
  ast: smartViews.ast,
  sort: smartViews.sort,
  columns: smartViews.columns,
  createdAt: smartViews.createdAt,
  updatedAt: smartViews.updatedAt,
} as const;

interface RawSmartViewRow {
  id: string;
  name: string;
  ownerId: string | null;
  shared: boolean;
  dsl: string;
  ast: Record<string, unknown>;
  sort: Record<string, unknown> | null;
  columns: unknown[] | null;
  createdAt: string;
  updatedAt: string;
}

function mapSmartView(r: RawSmartViewRow): RawSmartViewRow {
  return { ...r, createdAt: toIsoRequired(r.createdAt), updatedAt: toIsoRequired(r.updatedAt) };
}

// --- Preview request parsing ------------------------------------------------

const previewSchema = z.object({
  dsl: z.string().optional(),
  ast: z.unknown().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(PREVIEW_MAX_LIMIT).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  dsl: z.string().min(1),
  shared: z.boolean().optional(),
  sort: z.record(z.unknown()).optional(),
  columns: z.array(z.unknown()).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  dsl: z.string().min(1).optional(),
  shared: z.boolean().optional(),
  sort: z.record(z.unknown()).nullable().optional(),
  columns: z.array(z.unknown()).nullable().optional(),
});

type PreviewAst =
  { ast: Ast } | { errorMessage: string; position?: Position } | { badRequest: string };

function resolveAst(body: z.infer<typeof previewSchema>): PreviewAst {
  if (typeof body.dsl === 'string') {
    try {
      return { ast: parse(body.dsl, { fieldCatalog: FIELD_CATALOG }) };
    } catch (err) {
      if (err instanceof ParseError) {
        return { errorMessage: err.message, position: err.position };
      }
      throw err;
    }
  }
  if (body.ast !== undefined) {
    const parsed = astSchema.safeParse(body.ast);
    if (!parsed.success) return { errorMessage: 'invalid ast' };
    return { ast: parsed.data };
  }
  return { badRequest: 'Provide dsl or ast' };
}

export function registerDevSmartViewRoutes(app: FastifyInstance, deps: SmartViewRouteDeps): void {
  // POST /api/v1/smart-views/preview — first page + count-estimate for {dsl|ast}.
  app.post('/api/v1/smart-views/preview', async (request, reply) => {
    const parsedBody = previewSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid preview request',
        parsedBody.error.flatten(),
      );
    }
    const resolved = resolveAst(parsedBody.data);
    if ('badRequest' in resolved) return sendError(reply, 'VALIDATION_FAILED', resolved.badRequest);
    if ('errorMessage' in resolved) {
      const details = resolved.position !== undefined ? { position: resolved.position } : undefined;
      return sendError(reply, 'VALIDATION_FAILED', resolved.errorMessage, details);
    }
    const ast = resolved.ast;

    const ctx: CompileContext = {
      currentUserId: resolveCurrentUserId(request, deps.sessionSecret) ?? deps.defaultUserId,
      orgTimezone: deps.orgTimezone,
      fieldCatalog: FIELD_CATALOG,
      now: new Date(),
    };

    const limit = parsedBody.data.limit ?? PREVIEW_DEFAULT_LIMIT;

    // Page (fetch limit+1 to detect a next page).
    let cursor: CompileCursor | undefined;
    if (parsedBody.data.cursor !== undefined) {
      const c = decodeCursor(parsedBody.data.cursor);
      if (c === null) return sendError(reply, 'VALIDATION_FAILED', 'invalid cursor');
      cursor = { sortValue: c.v, id: c.id };
    }
    const pageOptions: CompileOptions = {
      limit: limit + 1,
      ...(cursor !== undefined ? { cursor } : {}),
    };
    const page = compile(ast, ctx, pageOptions);
    const idRes = await deps.client.query<{ id: string }>(page.sql, page.params);
    const orderedIds = idRes.rows.map((r) => r.id);
    const hasMore = orderedIds.length > limit;
    const pageIds = hasMore ? orderedIds.slice(0, limit) : orderedIds;

    // Hydrate full Lead rows, preserving compiled order.
    let items: ReturnType<typeof mapLead>[] = [];
    if (pageIds.length > 0) {
      const rows = (await deps.db
        .select(LEAD_COLUMNS)
        .from(leads)
        .where(inArray(leads.id, pageIds))) as Parameters<typeof mapLead>[0][];
      const byId = new Map(rows.map((r) => [r.id, mapLead(r)]));
      items = pageIds.flatMap((id) => {
        const lead = byId.get(id);
        return lead ? [lead] : [];
      });
    }

    // Count estimate: recompile with no cursor, neutralise the LIMIT param.
    const countCompiled = compile(ast, ctx, { limit: COMPILE_MAX_LIMIT });
    const countParams = countCompiled.params.slice(0, -1);
    countParams.push(COUNT_ALL);
    const countRes = await deps.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (${countCompiled.sql}) sub`,
      countParams,
    );
    const countEstimate = countRes.rows[0]?.n ?? items.length;

    if (hasMore) {
      const last = items[items.length - 1];
      if (last !== undefined) {
        return {
          items,
          countEstimate,
          nextCursor: encodeCursor({ v: last.createdAt, id: last.id }),
        };
      }
    }
    return { items, countEstimate };
  });

  // GET /api/v1/smart-views — list all saved views.
  app.get('/api/v1/smart-views', async () => {
    const rows = (await deps.db
      .select(SMARTVIEW_COLUMNS)
      .from(smartViews)
      .orderBy(asc(smartViews.createdAt), asc(smartViews.id))) as RawSmartViewRow[];
    return rows.map(mapSmartView);
  });

  // GET /api/v1/smart-views/:id
  app.get<{ Params: { id: string } }>('/api/v1/smart-views/:id', async (request, reply) => {
    const rows = (await deps.db
      .select(SMARTVIEW_COLUMNS)
      .from(smartViews)
      .where(eq(smartViews.id, request.params.id))
      .limit(1)) as RawSmartViewRow[];
    const row = rows[0];
    if (row === undefined) return sendError(reply, 'NOT_FOUND', 'Smart view not found');
    return mapSmartView(row);
  });

  // POST /api/v1/smart-views — create (validates DSL via the compiler's parser).
  app.post('/api/v1/smart-views', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'name and dsl are required',
        parsed.error.flatten(),
      );
    }
    let ast: Ast;
    try {
      ast = parse(parsed.data.dsl, { fieldCatalog: FIELD_CATALOG });
    } catch (err) {
      if (err instanceof ParseError) {
        return sendError(reply, 'VALIDATION_FAILED', err.message, { position: err.position });
      }
      throw err;
    }
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      name: parsed.data.name,
      ownerId: null,
      shared: parsed.data.shared === true,
      dsl: parsed.data.dsl,
      ast: ast as unknown as Record<string, unknown>,
      sort: parsed.data.sort ?? null,
      columns: parsed.data.columns ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await deps.db.insert(smartViews).values(row);
    return reply.status(201).send(mapSmartView(row));
  });

  // PATCH /api/v1/smart-views/:id — partial update (re-parses DSL if changed).
  app.patch<{ Params: { id: string } }>('/api/v1/smart-views/:id', async (request, reply) => {
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid update', parsed.error.flatten());
    }
    const existing = (await deps.db
      .select(SMARTVIEW_COLUMNS)
      .from(smartViews)
      .where(eq(smartViews.id, request.params.id))
      .limit(1)) as RawSmartViewRow[];
    if (existing[0] === undefined) return sendError(reply, 'NOT_FOUND', 'Smart view not found');

    const patch: Partial<RawSmartViewRow> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.shared !== undefined) patch.shared = parsed.data.shared;
    if (parsed.data.sort !== undefined) patch.sort = parsed.data.sort;
    if (parsed.data.columns !== undefined) patch.columns = parsed.data.columns;
    if (parsed.data.dsl !== undefined) {
      try {
        const ast = parse(parsed.data.dsl, { fieldCatalog: FIELD_CATALOG });
        patch.dsl = parsed.data.dsl;
        patch.ast = ast as unknown as Record<string, unknown>;
      } catch (err) {
        if (err instanceof ParseError) {
          return sendError(reply, 'VALIDATION_FAILED', err.message, { position: err.position });
        }
        throw err;
      }
    }
    patch.updatedAt = new Date().toISOString();

    const updated = (await deps.db
      .update(smartViews)
      .set(patch)
      .where(eq(smartViews.id, request.params.id))
      .returning(SMARTVIEW_COLUMNS)) as RawSmartViewRow[];
    const row = updated[0];
    if (row === undefined) return sendError(reply, 'NOT_FOUND', 'Smart view not found');
    return mapSmartView(row);
  });

  // DELETE /api/v1/smart-views/:id → 204
  app.delete<{ Params: { id: string } }>('/api/v1/smart-views/:id', async (request, reply) => {
    const deleted = (await deps.db
      .delete(smartViews)
      .where(eq(smartViews.id, request.params.id))
      .returning({ id: smartViews.id })) as { id: string }[];
    if (deleted[0] === undefined) return sendError(reply, 'NOT_FOUND', 'Smart view not found');
    return reply.status(204).send();
  });
}
