import { leads, type Db } from '../../db/index.ts';

/**
 * Smart-view service support helpers (Task R3). The Smart View compiler
 * (`@switchboard/shared`, CONTRACTS §C3) is the SINGLE query authority: it emits
 * `{sql, params}` with positional `$n` placeholders that must be executed by a
 * driver that binds params (Drizzle's `db.execute` builds its own `SQL` and
 * cannot run a pre-rendered `$n` string). So preview + bulk resolution run the
 * compiled SQL through a raw `query(sql, params)` client — exactly the path the
 * dev shim (`apps/api/src/dev/smart-views.ts`) and the DSL golden suite already
 * use. This module owns the tiny, self-contained glue that path needs: the raw
 * client seam, an opaque keyset cursor codec, ISO timestamp coercion, and the C7
 * Lead DTO projection — none of it imported from the DEV-ONLY `dev/` tree, which
 * the real API replaces.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

// --- Raw parameterized-SQL seam --------------------------------------------

/**
 * The minimal raw-query surface the compiler's `$n` SQL needs. Both drivers used
 * in this repo satisfy it structurally: PGlite's `client.query` (tests / dev) and
 * node-postgres `Pool.query` (production) both take `(sql, params)` and return
 * `{ rows }`.
 */
export interface RawQueryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Derive the underlying raw client from a Drizzle handle (`db.$client`). Drizzle
 * sets `$client` on every concrete driver database (PGlite instance / pg Pool),
 * but the driver-neutral `Db` type does not surface it — hence the guarded
 * `unknown` narrowing (never `any`). The composition root may instead inject an
 * explicit {@link RawQueryable}; this is the zero-wiring fallback.
 */
export function rawClientOf(db: Db): RawQueryable {
  const client: unknown = (db as unknown as { $client?: unknown }).$client;
  if (
    client === null ||
    typeof client !== 'object' ||
    typeof (client as { query?: unknown }).query !== 'function'
  ) {
    throw new Error('database handle exposes no raw $client.query(); inject a RawQueryable');
  }
  return client as RawQueryable;
}

// --- Opaque keyset cursor ---------------------------------------------------

export interface CursorParts {
  /** The previous page's last-row sort-column value (default sort: created_at). */
  v: string | number | boolean | null;
  /** The previous page's last-row id (keyset tiebreak). */
  id: string;
}

/** Encode a keyset cursor as an opaque base64url token (C7: cursors are opaque). */
export function encodeCursor(parts: CursorParts): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/** Decode a cursor token; `null` when malformed (caller maps that to 400). */
export function decodeCursor(raw: string): CursorParts | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      return null;
    }
    const { v, id } = parsed as { v: unknown; id: string };
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      return null;
    }
    return { v, id };
  } catch {
    return null;
  }
}

// --- Timestamps -------------------------------------------------------------

/**
 * Drizzle reads `timestamptz` columns back in Postgres text form
 * (`2026-07-10 12:34:56+00`), but the web (and its MSW fixtures) speak ISO-8601
 * with `T`/`Z`. Normalise every timestamp handed to the client so date parsing on
 * the web is identical to mock mode.
 */
export function toIso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** Non-null variant for required timestamps (created_at / updated_at). */
export function toIsoRequired(value: string): string {
  return new Date(value).toISOString();
}

// --- C7 Lead DTO projection -------------------------------------------------

/**
 * Explicit Lead DTO projection (CONTRACTS §C7). Must NOT select the generated
 * `search_tsv` / `search_text` columns, which are not part of the Lead shape.
 * Kept byte-identical to the dev leads read-shim so a real-API cutover returns
 * the same rows the web already renders.
 */
export const LEAD_COLUMNS = {
  id: leads.id,
  name: leads.name,
  url: leads.url,
  description: leads.description,
  statusId: leads.statusId,
  ownerId: leads.ownerId,
  custom: leads.custom,
  lastContactedAt: leads.lastContactedAt,
  lastInboundAt: leads.lastInboundAt,
  nextTaskDueAt: leads.nextTaskDueAt,
  lastCallAt: leads.lastCallAt,
  lastEmailAt: leads.lastEmailAt,
  lastSmsAt: leads.lastSmsAt,
  dnc: leads.dnc,
  deletedAt: leads.deletedAt,
  createdAt: leads.createdAt,
  updatedAt: leads.updatedAt,
} as const;

export interface RawLeadRow {
  id: string;
  name: string;
  url: string | null;
  description: string | null;
  statusId: string | null;
  ownerId: string | null;
  custom: Record<string, unknown>;
  lastContactedAt: string | null;
  lastInboundAt: string | null;
  nextTaskDueAt: string | null;
  lastCallAt: string | null;
  lastEmailAt: string | null;
  lastSmsAt: string | null;
  dnc: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Coerce a raw Drizzle lead row into the C7 Lead DTO (ISO timestamps). */
export function mapLead(r: RawLeadRow): RawLeadRow {
  return {
    ...r,
    lastContactedAt: toIso(r.lastContactedAt),
    lastInboundAt: toIso(r.lastInboundAt),
    nextTaskDueAt: toIso(r.nextTaskDueAt),
    lastCallAt: toIso(r.lastCallAt),
    lastEmailAt: toIso(r.lastEmailAt),
    lastSmsAt: toIso(r.lastSmsAt),
    deletedAt: toIso(r.deletedAt),
    createdAt: toIsoRequired(r.createdAt),
    updatedAt: toIsoRequired(r.updatedAt),
  };
}
