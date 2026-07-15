import { sql } from 'drizzle-orm';

import type { Db } from '../../db/index.ts';
import { decodeCursorTuple, encodeCursor } from './cursor.ts';
import {
  buildPage,
  clampLimit,
  resolveRange,
  type FunnelQuery,
  type FunnelStageRow,
  type ReportPage,
} from './schemas.ts';

/**
 * Funnel / pipeline report (Task 4g) — opportunities grouped by
 * `(currency, stage)`, currency-aware so values never sum across currencies
 * (CONTRACTS §C1: each opportunity carries its own currency).
 *
 * Per cell:
 *  - open*   — the current active-status snapshot: count, Σ value_cents, and
 *              confidence-weighted value Σ(value_cents × confidence ÷ 100).
 *  - won/lost — deals in that status whose `close_date` falls in the range
 *              (all-time when no range is given).
 *  - entered/exited — `opportunity_stage_changed` events (CONTRACTS §C4) in the
 *              range, attributed to this currency via the opportunity, counted by
 *              their `to` / `from` stage id. This is the stage-conversion signal:
 *              conversion rate between two stages = entered(next) ÷ exited(this).
 *
 * Opportunities with no stage are not part of any funnel stage and are excluded.
 * Every value is a bound parameter (CONTRACTS §C3). Ordering is
 * `(currency, stage sort_order, stage id)` — a total order — so the keyset page
 * is stable.
 */

interface RawRow {
  currency: string;
  stage_id: string;
  stage_label: string;
  stage_sort_order: unknown;
  open_count: unknown;
  open_value: unknown;
  open_weighted: unknown;
  won_count: unknown;
  won_value: unknown;
  lost_count: unknown;
  lost_value: unknown;
  entered_count: unknown;
  exited_count: unknown;
}

function toInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function mapRow(row: RawRow): FunnelStageRow {
  return {
    currency: String(row.currency),
    stageId: String(row.stage_id),
    stageLabel: String(row.stage_label),
    stageSortOrder: toInt(row.stage_sort_order),
    openCount: toInt(row.open_count),
    openValueCents: toInt(row.open_value),
    openWeightedValueCents: toInt(row.open_weighted),
    wonCount: toInt(row.won_count),
    wonValueCents: toInt(row.won_value),
    lostCount: toInt(row.lost_count),
    lostValueCents: toInt(row.lost_value),
    enteredCount: toInt(row.entered_count),
    exitedCount: toInt(row.exited_count),
  };
}

/**
 * Run the funnel report. Resolves the optional range (throws `ReportRangeError`
 * on a bad/oversized range) and decodes the cursor (throws `InvalidCursorError`);
 * both are mapped to `VALIDATION_FAILED` by the route.
 */
export async function runFunnelReport(
  db: Db,
  query: FunnelQuery,
): Promise<ReportPage<FunnelStageRow>> {
  const limit = clampLimit(query.limit);
  const currency = query.currency ?? null;

  // Optional range: won/lost by close_date (a DATE column → date bounds),
  // conversions by occurred_at (a timestamptz → instant bounds).
  let convFrom: string | null = null;
  let convToExcl: string | null = null;
  let closeFrom: string | null = null;
  let closeToExcl: string | null = null;
  if (query.from !== undefined && query.to !== undefined) {
    const r = resolveRange(query.from, query.to);
    convFrom = r.fromTs;
    convToExcl = r.toExclusiveTs;
    closeFrom = query.from;
    closeToExcl = r.toExclusiveTs.slice(0, 10);
  }

  let curCursor: string | null = null;
  let soCursor: number | null = null;
  let sidCursor: string | null = null;
  if (query.cursor !== undefined) {
    const [c, s, id] = decodeCursorTuple(query.cursor, ['string', 'number', 'string']);
    curCursor = String(c);
    soCursor = Number(s);
    sidCursor = String(id);
  }

  const closeClause =
    closeFrom !== null
      ? sql`AND close_date >= ${closeFrom}::date AND close_date < ${closeToExcl}::date`
      : sql``;
  const convRangeClause =
    convFrom !== null
      ? sql`AND a.occurred_at >= ${convFrom}::timestamptz AND a.occurred_at < ${convToExcl}::timestamptz`
      : sql``;
  const currencyOppClause = currency !== null ? sql`AND currency = ${currency}` : sql``;
  const currencyConvClause = currency !== null ? sql`AND o.currency = ${currency}` : sql``;

  const queryText = sql`
    WITH opp_agg AS (
      SELECT currency, stage_id,
        count(*) FILTER (WHERE status = 'active') AS open_count,
        coalesce(sum(value_cents) FILTER (WHERE status = 'active'), 0) AS open_value,
        coalesce(
          round(sum((value_cents::numeric * confidence) / 100.0) FILTER (WHERE status = 'active')),
          0
        ) AS open_weighted,
        count(*) FILTER (WHERE status = 'won' ${closeClause}) AS won_count,
        coalesce(sum(value_cents) FILTER (WHERE status = 'won' ${closeClause}), 0) AS won_value,
        count(*) FILTER (WHERE status = 'lost' ${closeClause}) AS lost_count,
        coalesce(sum(value_cents) FILTER (WHERE status = 'lost' ${closeClause}), 0) AS lost_value
      FROM opportunities
      WHERE stage_id IS NOT NULL ${currencyOppClause}
      GROUP BY currency, stage_id
    ),
    conv AS (
      SELECT o.currency AS currency,
        a.payload->>'to' AS to_stage,
        a.payload->>'from' AS from_stage
      FROM activities a
      JOIN opportunities o ON o.id::text = a.payload->>'opportunityId'
      WHERE a.type = 'opportunity_stage_changed' ${convRangeClause} ${currencyConvClause}
    ),
    entered AS (
      SELECT currency, to_stage AS stage_id, count(*) AS c
      FROM conv WHERE to_stage IS NOT NULL GROUP BY currency, to_stage
    ),
    exited AS (
      SELECT currency, from_stage AS stage_id, count(*) AS c
      FROM conv WHERE from_stage IS NOT NULL GROUP BY currency, from_stage
    ),
    keys AS (
      SELECT currency, stage_id::text AS stage_id FROM opp_agg
      UNION SELECT currency, stage_id FROM entered
      UNION SELECT currency, stage_id FROM exited
    )
    SELECT k.currency AS currency,
      s.id::text AS stage_id,
      s.label AS stage_label,
      s.sort_order AS stage_sort_order,
      coalesce(oa.open_count, 0) AS open_count,
      coalesce(oa.open_value, 0) AS open_value,
      coalesce(oa.open_weighted, 0) AS open_weighted,
      coalesce(oa.won_count, 0) AS won_count,
      coalesce(oa.won_value, 0) AS won_value,
      coalesce(oa.lost_count, 0) AS lost_count,
      coalesce(oa.lost_value, 0) AS lost_value,
      coalesce(en.c, 0) AS entered_count,
      coalesce(ex.c, 0) AS exited_count
    FROM keys k
    JOIN opportunity_stages s ON s.id::text = k.stage_id
    LEFT JOIN opp_agg oa ON oa.currency = k.currency AND oa.stage_id::text = k.stage_id
    LEFT JOIN entered en ON en.currency = k.currency AND en.stage_id = k.stage_id
    LEFT JOIN exited ex ON ex.currency = k.currency AND ex.stage_id = k.stage_id
    WHERE (${curCursor}::text IS NULL)
       OR (k.currency > ${curCursor}::char(3))
       OR (k.currency = ${curCursor}::char(3) AND s.sort_order > ${soCursor}::int)
       OR (k.currency = ${curCursor}::char(3) AND s.sort_order = ${soCursor}::int AND s.id::text > ${sidCursor}::text)
    ORDER BY k.currency ASC, s.sort_order ASC, s.id ASC
    LIMIT ${limit + 1}
  `;

  const result = await db.execute(queryText);
  const rows = (result as { rows: RawRow[] }).rows.map(mapRow);
  return buildPage(rows, limit, (r) =>
    encodeCursor([r.currency, r.stageSortOrder, r.stageId]),
  );
}
