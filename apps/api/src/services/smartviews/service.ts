import { randomUUID } from 'node:crypto';
import { asc, eq, isNull, or, type SQL } from 'drizzle-orm';
import { astSchema, parse, type Ast, type DslCustomFieldDef } from '@switchboard/shared';

import { smartViews, type Db } from '../../db/index.ts';
import {
  buildCompileContext,
  countEstimate,
  hydrateLeads,
  loadLeadFieldCatalog,
  runIdPage,
} from './query.ts';
import {
  decodeCursor,
  encodeCursor,
  toIsoRequired,
  type RawLeadRow,
  type RawQueryable,
} from './support.ts';

/**
 * Smart-view CRUD + preview service (Task R3, CONTRACTS §C7). Backs the real
 * `/api/v1/smart-views` routes the web already calls (drop-in for the MSW layer):
 * list (owner + shared), read, create, patch, delete, and the preview that runs a
 * `{dsl|ast}` through the SINGLE query authority (`@switchboard/shared`) against
 * the real `leads` table and returns the first keyset page + a count estimate.
 *
 * Every stored/submitted DSL is validated by the compiler's parser at write time,
 * so a smart_views row's `dsl`/`ast` always round-trips (C3). No hand-written
 * query — the compiler owns the WHERE clause.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const PREVIEW_DEFAULT_LIMIT = 25;
const PREVIEW_MAX_LIMIT = 100;

// --- Errors ----------------------------------------------------------------

/** Bad request that is not a DSL parse error (e.g. neither dsl nor ast). 400. */
export class SmartViewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmartViewInputError';
  }
}

// Re-export so route + bulk callers catch a single ParseError symbol.
export { ParseError } from '@switchboard/shared';

// --- Row shape --------------------------------------------------------------

export interface SmartViewRecord {
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

function mapSmartView(r: RawSmartViewRow): SmartViewRecord {
  return { ...r, createdAt: toIsoRequired(r.createdAt), updatedAt: toIsoRequired(r.updatedAt) };
}

// --- Input DTOs -------------------------------------------------------------

export interface SmartViewCreateInput {
  name: string;
  dsl: string;
  shared?: boolean;
  sort?: Record<string, unknown> | null;
  columns?: unknown[] | null;
}

export interface SmartViewUpdateInput {
  name?: string;
  dsl?: string;
  shared?: boolean;
  sort?: Record<string, unknown> | null;
  columns?: unknown[] | null;
}

export interface SmartViewPreviewInput {
  dsl?: string;
  ast?: unknown;
  cursor?: string;
  limit?: number;
}

export interface SmartViewPreviewResult {
  items: RawLeadRow[];
  countEstimate: number;
  nextCursor?: string;
}

export interface SmartViewServiceDeps {
  db: Db;
  /** Raw client for the compiler's `$n` SQL (see support.ts). */
  client: RawQueryable;
  /** Org timezone; relative-date resolution anchors here (C3). */
  orgTimezone: string;
}

export class SmartViewService {
  private readonly db: Db;
  private readonly client: RawQueryable;
  private readonly orgTimezone: string;

  constructor(deps: SmartViewServiceDeps) {
    this.db = deps.db;
    this.client = deps.client;
    this.orgTimezone = deps.orgTimezone;
  }

  /**
   * List views visible to `currentUserId`: shared views, the user's own, and
   * unowned/system views (`owner_id IS NULL` — the seed/demo set, visible to all).
   * This satisfies C7's "owner + shared" while matching the web's single-user
   * mock (which shows every seeded view).
   */
  async list(currentUserId: string): Promise<SmartViewRecord[]> {
    const visible = or(
      eq(smartViews.shared, true),
      eq(smartViews.ownerId, currentUserId),
      isNull(smartViews.ownerId),
    ) as SQL;
    const rows = (await this.db
      .select(SMARTVIEW_COLUMNS)
      .from(smartViews)
      .where(visible)
      .orderBy(asc(smartViews.createdAt), asc(smartViews.id))) as RawSmartViewRow[];
    return rows.map(mapSmartView);
  }

  async get(id: string): Promise<SmartViewRecord | null> {
    const rows = (await this.db
      .select(SMARTVIEW_COLUMNS)
      .from(smartViews)
      .where(eq(smartViews.id, id))
      .limit(1)) as RawSmartViewRow[];
    return rows[0] === undefined ? null : mapSmartView(rows[0]);
  }

  /** Create a view. `dsl` is parsed (with the live catalog) → stored ast. */
  async create(input: SmartViewCreateInput, ownerId: string | null): Promise<SmartViewRecord> {
    const ast = await this.parseDsl(input.dsl);
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      name: input.name,
      ownerId,
      shared: input.shared === true,
      dsl: input.dsl,
      ast: ast as unknown as Record<string, unknown>,
      sort: input.sort ?? null,
      columns: input.columns ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(smartViews).values(row);
    return mapSmartView(row);
  }

  /** Partial update; re-parses `dsl` (and refreshes the stored ast) if present. */
  async update(id: string, patch: SmartViewUpdateInput): Promise<SmartViewRecord | null> {
    const existing = await this.get(id);
    if (existing === null) return null;

    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.shared !== undefined) set.shared = patch.shared;
    if (patch.sort !== undefined) set.sort = patch.sort;
    if (patch.columns !== undefined) set.columns = patch.columns;
    if (patch.dsl !== undefined) {
      const ast = await this.parseDsl(patch.dsl);
      set.dsl = patch.dsl;
      set.ast = ast as unknown as Record<string, unknown>;
    }

    const updated = (await this.db
      .update(smartViews)
      .set(set)
      .where(eq(smartViews.id, id))
      .returning(SMARTVIEW_COLUMNS)) as RawSmartViewRow[];
    return updated[0] === undefined ? null : mapSmartView(updated[0]);
  }

  async remove(id: string): Promise<boolean> {
    const deleted = (await this.db
      .delete(smartViews)
      .where(eq(smartViews.id, id))
      .returning({ id: smartViews.id })) as { id: string }[];
    return deleted[0] !== undefined;
  }

  /**
   * Preview a `{dsl|ast}`: first keyset page of matching leads + a count estimate.
   * The compiler produces the SQL; execution binds parameters only (C3).
   */
  async preview(
    input: SmartViewPreviewInput,
    currentUserId: string,
    now: Date,
  ): Promise<SmartViewPreviewResult> {
    const catalog = await loadLeadFieldCatalog(this.db);
    const ast = await this.resolveInputAst(input, catalog);
    const ctx = buildCompileContext(currentUserId, this.orgTimezone, catalog, now);

    const limit = clampPreviewLimit(input.limit);
    let cursor: { sortValue: string | number | boolean | null; id: string } | undefined;
    if (input.cursor !== undefined) {
      const c = decodeCursor(input.cursor);
      if (c === null) throw new SmartViewInputError('invalid cursor');
      cursor = { sortValue: c.v, id: c.id };
    }

    const page = await runIdPage(this.client, ast, ctx, limit, cursor);
    const items = await hydrateLeads(this.db, page.ids);
    const count = await countEstimate(this.client, ast, ctx);

    if (page.hasMore) {
      const last = items[items.length - 1];
      if (last !== undefined) {
        return {
          items,
          countEstimate: count,
          nextCursor: encodeCursor({ v: last.createdAt, id: last.id }),
        };
      }
    }
    return { items, countEstimate: count };
  }

  /** Load a stored view's ast (validated), for a bulk action target set. */
  async astForView(id: string): Promise<Ast | null> {
    const rows = (await this.db
      .select({ ast: smartViews.ast })
      .from(smartViews)
      .where(eq(smartViews.id, id))
      .limit(1)) as { ast: Record<string, unknown> }[];
    if (rows[0] === undefined) return null;
    const parsed = astSchema.safeParse(rows[0].ast);
    if (!parsed.success) throw new SmartViewInputError('stored ast is invalid');
    return parsed.data;
  }

  /** Parse a DSL string against the live lead catalog. Throws ParseError. */
  private async parseDsl(dsl: string): Promise<Ast> {
    const catalog = await loadLeadFieldCatalog(this.db);
    return parse(dsl, { fieldCatalog: catalog });
  }

  /** Resolve a preview input to a compiled-ready ast (dsl parse or ast validate). */
  private async resolveInputAst(
    input: SmartViewPreviewInput,
    catalog: readonly DslCustomFieldDef[],
  ): Promise<Ast> {
    if (typeof input.dsl === 'string') {
      return parse(input.dsl, { fieldCatalog: catalog });
    }
    if (input.ast !== undefined) {
      const parsed = astSchema.safeParse(input.ast);
      if (!parsed.success) throw new SmartViewInputError('invalid ast');
      return parsed.data;
    }
    throw new SmartViewInputError('Provide dsl or ast');
  }
}

function clampPreviewLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return PREVIEW_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > PREVIEW_MAX_LIMIT) return PREVIEW_MAX_LIMIT;
  return n;
}

/** Standalone ast validator for callers that receive a raw ast (e.g. bulk). */
export function parseRawAst(raw: unknown): Ast {
  const parsed = astSchema.safeParse(raw);
  if (!parsed.success) throw new SmartViewInputError('invalid ast');
  return parsed.data;
}
