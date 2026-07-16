import { and, eq, inArray } from 'drizzle-orm';
import {
  compile,
  MAX_LIMIT as COMPILE_MAX_LIMIT,
  type Ast,
  type CompileContext,
  type CompileOptions,
  type Cursor as CompileCursor,
  type DslCustomFieldDef,
} from '@switchboard/shared';

import { customFieldDefs, leads, type Db } from '../../db/index.ts';
import { LEAD_COLUMNS, mapLead, type RawLeadRow, type RawQueryable } from './support.ts';

/**
 * Compiler execution layer (Task R3, CONTRACTS §C3 / ARCHITECTURE §1). Everything
 * here funnels the stored/submitted AST through the SINGLE query authority
 * (`@switchboard/shared` `compile`) and executes the resulting parameterized SQL —
 * NO hand-written WHERE clause. Two consumers: the preview endpoint (first page +
 * count estimate + keyset cursor) and bulk-action target resolution (the full
 * matching id set, capped). This is the exact query path the dev shim proved,
 * promoted verbatim into the real service.
 */

/** Sentinel that neutralises the compiled page LIMIT to get a true count. */
const COUNT_ALL = 1_000_000;
/** Page size used when walking the full matching set for a bulk action. */
export const BULK_PAGE_SIZE = COMPILE_MAX_LIMIT;
/** Hard ceiling on a single bulk action's target set (bounds worst-case work). */
export const MAX_BULK_TARGETS = 10_000;

/**
 * Load the lead-entity custom-field catalog (C1 `custom_field_defs`) as the DSL's
 * `fieldCatalog` whitelist. Only lead-entity fields are addressable as
 * `custom.<key>` (C3); an unknown key is a parse error. Real mode resolves the
 * live catalog, so `custom.<key>` predicates work end-to-end (the dev shim used an
 * empty catalog and could not).
 */
export async function loadLeadFieldCatalog(db: Db): Promise<DslCustomFieldDef[]> {
  const rows = await db
    .select({
      key: customFieldDefs.key,
      entity: customFieldDefs.entity,
      type: customFieldDefs.type,
      options: customFieldDefs.options,
    })
    .from(customFieldDefs)
    .where(eq(customFieldDefs.entity, 'lead'));
  return rows.map((r) => ({
    key: r.key,
    entity: r.entity,
    type: r.type,
    options: r.options ?? null,
  }));
}

/** Build the compile/parse execution context (C3). */
export function buildCompileContext(
  currentUserId: string,
  orgTimezone: string,
  fieldCatalog: readonly DslCustomFieldDef[],
  now: Date,
): CompileContext {
  return { currentUserId, orgTimezone, fieldCatalog, now };
}

export interface IdPage {
  /** Ids of this page, in compiled sort order (default: created_at DESC, id DESC). */
  ids: string[];
  /** True when the underlying query returned more than `limit` rows. */
  hasMore: boolean;
}

/**
 * Run one compiled page. Fetches `limit + 1` rows to detect a following page
 * without a second round-trip. The compiled SELECT projects only `leads.id`.
 */
export async function runIdPage(
  client: RawQueryable,
  ast: Ast,
  ctx: CompileContext,
  limit: number,
  cursor?: CompileCursor,
): Promise<IdPage> {
  const options: CompileOptions = {
    limit: limit + 1,
    ...(cursor !== undefined ? { cursor } : {}),
  };
  const { sql, params } = compile(ast, ctx, options);
  const res = await client.query<{ id: string }>(sql, params);
  const ids = res.rows.map((r) => r.id);
  const hasMore = ids.length > limit;
  return { ids: hasMore ? ids.slice(0, limit) : ids, hasMore };
}

/**
 * Count estimate for a view: recompile with no cursor and the max LIMIT, then
 * neutralise the trailing LIMIT param (always pushed last by the compiler) so the
 * wrapping `count(*)` sees every matching row. Parameters-only throughout.
 */
export async function countEstimate(
  client: RawQueryable,
  ast: Ast,
  ctx: CompileContext,
): Promise<number> {
  const compiled = compile(ast, ctx, { limit: COMPILE_MAX_LIMIT });
  const params = compiled.params.slice(0, -1);
  params.push(COUNT_ALL);
  const res = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (${compiled.sql}) sub`,
    params,
  );
  return res.rows[0]?.n ?? 0;
}

/**
 * Hydrate full Lead DTO rows for a page of ids, preserving the compiled order.
 * (`inArray` returns rows unordered, so we re-index by id.)
 */
export async function hydrateLeads(db: Db, orderedIds: readonly string[]): Promise<RawLeadRow[]> {
  if (orderedIds.length === 0) return [];
  const rows = (await db
    .select(LEAD_COLUMNS)
    .from(leads)
    .where(inArray(leads.id, [...orderedIds]))) as RawLeadRow[];
  const byId = new Map(rows.map((r) => [r.id, mapLead(r)]));
  return orderedIds.flatMap((id) => {
    const lead = byId.get(id);
    return lead ? [lead] : [];
  });
}

export interface ResolvedTargets {
  ids: string[];
  /** True when the matching set exceeded {@link MAX_BULK_TARGETS} and was cut. */
  truncated: boolean;
}

/**
 * Resolve the full set of lead ids matching a view, for a bulk action. Walks the
 * compiled query with keyset cursors (default sort: created_at DESC, id DESC),
 * capped at {@link MAX_BULK_TARGETS}. The cursor's sort value is the last row's
 * `created_at`, looked up from `leads` — the compiled SELECT only returns `id`.
 */
export async function resolveTargetIds(
  db: Db,
  client: RawQueryable,
  ast: Ast,
  ctx: CompileContext,
  opts: { pageSize?: number; cap?: number } = {},
): Promise<ResolvedTargets> {
  const pageSize = opts.pageSize ?? BULK_PAGE_SIZE;
  const cap = opts.cap ?? MAX_BULK_TARGETS;
  const ids: string[] = [];
  let cursor: CompileCursor | undefined;

  for (;;) {
    const page = await runIdPage(client, ast, ctx, pageSize, cursor);
    for (const id of page.ids) {
      ids.push(id);
      if (ids.length >= cap) return { ids, truncated: true };
    }
    if (!page.hasMore) return { ids, truncated: false };

    const lastId = page.ids[page.ids.length - 1];
    if (lastId === undefined) return { ids, truncated: false };
    const created = await db
      .select({ createdAt: leads.createdAt })
      .from(leads)
      .where(and(eq(leads.id, lastId)))
      .limit(1);
    const createdAt = created[0]?.createdAt;
    if (createdAt === undefined) return { ids, truncated: false };
    cursor = { sortValue: createdAt, id: lastId };
  }
}
