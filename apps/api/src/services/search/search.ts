import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/index.ts';

/**
 * Global search service (Task 1e / ARCHITECTURE §1/§9, CONTRACTS §C7).
 *
 * Combines three index-backed signals over `leads` and `contacts` into one
 * ranked result set:
 *   1. Postgres FTS — `websearch_to_tsquery('english', q)` against the generated
 *      `search_tsv` columns (whole words: lead/contact names, titles, and the
 *      email addresses the text-search parser recognises as single tokens).
 *   2. Trigram substring — `search_text LIKE '%q%'` (pg_trgm GIN): fragments the
 *      FTS parser can't reach — a slug inside a URL, an email fragment, a phone
 *      substring.
 *   3. Trigram similarity — `name % q` + `similarity(name, q)`: short / typo'd
 *      queries against the cleaner name column.
 *
 * Ranking is a deterministic integer score (exact name > FTS word > name prefix >
 * substring > fuzzy), and ordering is `(score DESC, id ASC)` — a total order,
 * since ids are globally-unique uuids — so keyset pagination is stable.
 *
 * Parameters only: every user value flows through drizzle `${}` placeholders; the
 * only `sql.raw` uses are compile-time-constant column identifiers. Empty/short
 * queries short-circuit to an empty page (never an error). No external providers
 * are touched, so the service runs unchanged under `MOCK_MODE=1`.
 *
 * Import-safe for direct `node` execution (the perf harness imports it): no
 * enums / namespaces / parameter properties.
 */

// --- Public types -----------------------------------------------------------

export type SearchResultType = 'lead' | 'contact';

export interface SearchResult {
  type: SearchResultType;
  /** Row id (lead id for `lead`, contact id for `contact`). */
  id: string;
  /** Owning lead id — equal to `id` for a `lead`, the parent for a `contact`. */
  leadId: string;
  title: string;
  subtitle: string | null;
  /** Normalised relevance (higher is better); `score / 1_000_000`. */
  rank: number;
}

export interface SearchPage {
  items: SearchResult[];
  /** Opaque keyset cursor for the next page; omitted when the page is the last. */
  nextCursor?: string;
}

export interface SearchOptions {
  limit?: number;
  cursor?: string;
}

/** Minimum trimmed query length; anything shorter yields an empty page. */
export const MIN_QUERY_LENGTH = 2;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
/** Integer-score → float-rank divisor (keeps the keyset key integral & exact). */
const SCORE_SCALE = 1_000_000;

/** Thrown when a supplied pagination cursor is malformed. Maps to 400 at the API. */
export class InvalidCursorError extends Error {
  constructor(message = 'invalid search cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

// --- Cursor codec (opaque base64url of `score:id`) --------------------------

interface Cursor {
  score: number;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.score}:${c.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }
  const sep = decoded.indexOf(':');
  if (sep <= 0) throw new InvalidCursorError();
  const scoreStr = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!/^\d+$/.test(scoreStr) || !UUID_RE.test(id)) throw new InvalidCursorError();
  const score = Number(scoreStr);
  if (!Number.isSafeInteger(score)) throw new InvalidCursorError();
  return { score, id };
}

// --- LIKE escaping ----------------------------------------------------------

/** Escape LIKE metacharacters so a query is matched literally (ESCAPE '\'). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// --- Query fragments (column identifiers are compile-time constants) --------

interface Cols {
  readonly name: string;
  readonly tsv: string;
  readonly text: string;
}

const LEAD_COLS: Cols = { name: 'l.name', tsv: 'l.search_tsv', text: 'l.search_text' };
const CONTACT_COLS: Cols = { name: 'c.name', tsv: 'c.search_tsv', text: 'c.search_text' };

function raw(id: string): SQL {
  return sql.raw(id);
}

/** `<tsv> @@ websearch_to_tsquery('english', $q)`. */
function ftsMatch(cols: Cols, q: string): SQL {
  return sql`${raw(cols.tsv)} @@ websearch_to_tsquery('english', ${q})`;
}

/** Integer relevance score for one candidate row. */
function scoreExpr(cols: Cols, q: string, qLower: string, likePat: string, prefixPat: string): SQL {
  return sql`(
      CASE WHEN lower(${raw(cols.name)}) = ${qLower} THEN 1000000 ELSE 0 END
    + CASE WHEN ${ftsMatch(cols, q)} THEN 300000 ELSE 0 END
    + CASE WHEN ${raw(cols.name)} ILIKE ${prefixPat} ESCAPE '\\' THEN 200000 ELSE 0 END
    + CASE WHEN ${raw(cols.text)} LIKE ${likePat} ESCAPE '\\' THEN 100000 ELSE 0 END
    + round(ts_rank(${raw(cols.tsv)}, websearch_to_tsquery('english', ${q})) * 50000)::int
    + round(similarity(${raw(cols.name)}, ${qLower}) * 150000)::int
    )::int`;
}

/** Row qualifies when any signal fires. */
function matchPred(cols: Cols, q: string, qLower: string, likePat: string, prefixPat: string): SQL {
  return sql`(
      ${ftsMatch(cols, q)}
   OR ${raw(cols.name)} ILIKE ${prefixPat} ESCAPE '\\'
   OR ${raw(cols.text)} LIKE ${likePat} ESCAPE '\\'
   OR ${raw(cols.name)} % ${qLower}
  )`;
}

// --- Row mapping ------------------------------------------------------------

interface ScoredRow {
  type: SearchResultType;
  id: string;
  leadId: string;
  title: string;
  subtitle: string | null;
  score: number;
}

function mapRow(row: Record<string, unknown>): ScoredRow {
  const type = row['type'] === 'contact' ? 'contact' : 'lead';
  const subtitle = row['subtitle'];
  return {
    type,
    id: String(row['id']),
    leadId: String(row['lead_id']),
    title: String(row['title'] ?? ''),
    subtitle: subtitle === null || subtitle === undefined ? null : String(subtitle),
    score: Number(row['score']),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

// --- Service ----------------------------------------------------------------

export class SearchService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async search(rawQuery: string, opts: SearchOptions = {}): Promise<SearchPage> {
    const q = rawQuery.trim();
    const limit = clampLimit(opts.limit);
    if (q.length < MIN_QUERY_LENGTH) return { items: [] };

    const cursor = opts.cursor !== undefined ? decodeCursor(opts.cursor) : null;

    const qLower = q.toLowerCase();
    const escaped = escapeLike(qLower);
    const likePat = `%${escaped}%`;
    const prefixPat = `${escaped}%`;

    const leadScore = scoreExpr(LEAD_COLS, q, qLower, likePat, prefixPat);
    const contactScore = scoreExpr(CONTACT_COLS, q, qLower, likePat, prefixPat);
    const leadPred = matchPred(LEAD_COLS, q, qLower, likePat, prefixPat);
    const contactPred = matchPred(CONTACT_COLS, q, qLower, likePat, prefixPat);

    const cursorClause = cursor
      ? sql`WHERE (score < ${cursor.score}) OR (score = ${cursor.score} AND id > ${cursor.id})`
      : sql``;

    const query = sql`
      WITH matches AS (
        SELECT 'lead'::text AS type, l.id AS id, l.id AS lead_id, l.name AS title,
               l.url AS subtitle, ${leadScore} AS score
        FROM leads l
        WHERE l.deleted_at IS NULL AND ${leadPred}
        UNION ALL
        SELECT 'contact'::text AS type, c.id AS id, c.lead_id AS lead_id, c.name AS title,
               coalesce(c.emails->0->>'email', c.title) AS subtitle, ${contactScore} AS score
        FROM contacts c
        WHERE c.deleted_at IS NULL AND ${contactPred}
      )
      SELECT type, id, lead_id, title, subtitle, score
      FROM matches
      ${cursorClause}
      ORDER BY score DESC, id ASC
      LIMIT ${limit + 1}
    `;

    const result = await this.db.execute(query);
    const rows = (result as { rows: Record<string, unknown>[] }).rows.map(mapRow);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items: SearchResult[] = pageRows.map((r) => ({
      type: r.type,
      id: r.id,
      leadId: r.leadId,
      title: r.title,
      subtitle: r.subtitle,
      rank: r.score / SCORE_SCALE,
    }));

    if (!hasMore) return { items };
    const last = pageRows[pageRows.length - 1];
    if (last === undefined) return { items };
    return { items, nextCursor: encodeCursor({ score: last.score, id: last.id }) };
  }
}
