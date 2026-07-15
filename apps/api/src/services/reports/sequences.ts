import { sql } from 'drizzle-orm';

import type { Db } from '../../db/index.ts';
import { decodeCursorTuple, encodeCursor } from './cursor.ts';
import {
  buildPage,
  clampLimit,
  resolveRange,
  type ReportPage,
  type SequenceReportRow,
  type SequencesQuery,
} from './schemas.ts';

/**
 * Sequence performance report (Task 4g). Per sequence: send/reply/bounce/
 * unsubscribe/finish event counts off the `activities` spine (CONTRACTS §C4),
 * plus the current active/paused enrollment snapshot (CONTRACTS §C1).
 *
 * Events are attributed to a sequence through each event's `enrollmentId`
 * payload field → `sequence_enrollments.sequence_id`. Replies, bounces, and
 * unsubscribes are `sequence_paused` rows discriminated by their `reason`
 * (CONTRACTS §C4: reason ∈ reply|bounce|manual|unsubscribe). An optional range
 * scopes the event counts by `occurred_at`; the enrollment snapshot is always
 * current. The report anchors on `sequences`, so a sequence with zero activity
 * still returns an all-zero row.
 *
 * Raw `email_bounced` events carry no enrollment link in the C4 schema, so they
 * are not sequence-attributable here; the sequence-relevant bounce is
 * `sequence_paused(reason=bounce)` (see task report). Every value is a bound
 * parameter (CONTRACTS §C3); ordering is `(name, id)` — a total order — for a
 * stable keyset page.
 */

interface RawRow {
  sequence_id: string;
  sequence_name: string;
  sequence_status: string;
  sends: unknown;
  replies: unknown;
  bounces: unknown;
  unsubscribes: unknown;
  finishes: unknown;
  active_enrollments: unknown;
  paused_enrollments: unknown;
}

function toInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function mapRow(row: RawRow): SequenceReportRow {
  const status = row.sequence_status === 'archived' ? 'archived' : 'active';
  return {
    sequenceId: String(row.sequence_id),
    sequenceName: String(row.sequence_name),
    sequenceStatus: status,
    sends: toInt(row.sends),
    replies: toInt(row.replies),
    bounces: toInt(row.bounces),
    unsubscribes: toInt(row.unsubscribes),
    finishes: toInt(row.finishes),
    activeEnrollments: toInt(row.active_enrollments),
    pausedEnrollments: toInt(row.paused_enrollments),
  };
}

/**
 * Run the sequences report. Resolves the optional range (throws
 * `ReportRangeError`) and decodes the cursor (throws `InvalidCursorError`); both
 * are mapped to `VALIDATION_FAILED` by the route.
 */
export async function runSequencesReport(
  db: Db,
  query: SequencesQuery,
): Promise<ReportPage<SequenceReportRow>> {
  const limit = clampLimit(query.limit);
  const sequenceId = query.sequenceId ?? null;

  let rangeFrom: string | null = null;
  let rangeToExcl: string | null = null;
  if (query.from !== undefined && query.to !== undefined) {
    const r = resolveRange(query.from, query.to);
    rangeFrom = r.fromTs;
    rangeToExcl = r.toExclusiveTs;
  }

  let nameCursor: string | null = null;
  let idCursor: string | null = null;
  if (query.cursor !== undefined) {
    const [name, id] = decodeCursorTuple(query.cursor, ['string', 'string']);
    nameCursor = String(name);
    idCursor = String(id);
  }

  const rangeClause =
    rangeFrom !== null
      ? sql`AND a.occurred_at >= ${rangeFrom}::timestamptz AND a.occurred_at < ${rangeToExcl}::timestamptz`
      : sql``;

  const queryText = sql`
    WITH ev AS (
      SELECT e.sequence_id AS sid,
        count(*) FILTER (WHERE a.type = 'sequence_step_sent') AS sends,
        count(*) FILTER (WHERE a.type = 'sequence_paused' AND a.payload->>'reason' = 'reply') AS replies,
        count(*) FILTER (WHERE a.type = 'sequence_paused' AND a.payload->>'reason' = 'bounce') AS bounces,
        count(*) FILTER (WHERE a.type = 'sequence_paused' AND a.payload->>'reason' = 'unsubscribe') AS unsubscribes,
        count(*) FILTER (WHERE a.type = 'sequence_finished') AS finishes
      FROM activities a
      JOIN sequence_enrollments e ON e.id::text = a.payload->>'enrollmentId'
      WHERE a.type IN ('sequence_step_sent', 'sequence_paused', 'sequence_finished')
        ${rangeClause}
      GROUP BY e.sequence_id
    ),
    enr AS (
      SELECT sequence_id AS sid,
        count(*) FILTER (WHERE state = 'active') AS active_enrollments,
        count(*) FILTER (WHERE state = 'paused') AS paused_enrollments
      FROM sequence_enrollments
      GROUP BY sequence_id
    )
    SELECT s.id::text AS sequence_id,
      s.name AS sequence_name,
      s.status AS sequence_status,
      coalesce(ev.sends, 0) AS sends,
      coalesce(ev.replies, 0) AS replies,
      coalesce(ev.bounces, 0) AS bounces,
      coalesce(ev.unsubscribes, 0) AS unsubscribes,
      coalesce(ev.finishes, 0) AS finishes,
      coalesce(enr.active_enrollments, 0) AS active_enrollments,
      coalesce(enr.paused_enrollments, 0) AS paused_enrollments
    FROM sequences s
    LEFT JOIN ev ON ev.sid = s.id
    LEFT JOIN enr ON enr.sid = s.id
    WHERE (${sequenceId}::uuid IS NULL OR s.id = ${sequenceId}::uuid)
      AND (
        (${nameCursor}::text IS NULL)
        OR (s.name > ${nameCursor}::text)
        OR (s.name = ${nameCursor}::text AND s.id::text > ${idCursor}::text)
      )
    ORDER BY s.name ASC, s.id ASC
    LIMIT ${limit + 1}
  `;

  const result = await db.execute(queryText);
  const rows = (result as { rows: RawRow[] }).rows.map(mapRow);
  return buildPage(rows, limit, (r) => encodeCursor([r.sequenceName, r.sequenceId]));
}
