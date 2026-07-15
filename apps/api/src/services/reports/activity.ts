import { sql, type SQL } from 'drizzle-orm';

import type { Db } from '../../db/index.ts';
import { decodeCursorTuple, encodeCursor } from './cursor.ts';
import {
  buildPage,
  clampLimit,
  resolveRange,
  type ActivityQuery,
  type ActivityReportRow,
  type ReportPage,
} from './schemas.ts';

/**
 * Activity report (Task 4g) — per-rep or per-day activity metrics over the
 * `activities` spine (CONTRACTS §C1/§C4), plus talk time summed from
 * `calls.duration_s`.
 *
 * Grouping key (`bucket`): the rep's user id when `groupBy=user`, or a
 * `YYYY-MM-DD` UTC calendar day when `groupBy=day`. Day bucketing is computed
 * SQL-side with an explicit `AT TIME ZONE 'UTC'` so it is independent of the DB
 * session timezone (CONTRACTS §C3). In `user` mode, activities with no
 * `user_id` cannot be attributed to a rep and are excluded; a `userId` filter is
 * anchored on `users`, so a rep with zero activity in the window still returns a
 * single all-zero row.
 *
 * Every value flows through bound parameters — no user input is spliced into SQL
 * (CONTRACTS §C3). Ordering is `bucket ASC` (a total order: user ids are unique
 * uuids, days are unique), so the keyset page is stable.
 */

type GroupBy = ActivityQuery['groupBy'];

/** The activity types this report buckets (prunes the spine scan). */
const REPORTED_TYPES = [
  'call_logged',
  'call_missed',
  'voicemail_received',
  'email_sent',
  'email_received',
  'sms_sent',
  'sms_received',
  'note_added',
  'task_completed',
] as const;

/** Compile-time-constant bucket expression per source table (no user input). */
function bucketRaw(mode: GroupBy, alias: string, tsCol: string): SQL {
  if (mode === 'user') return sql.raw(`${alias}.user_id::text`);
  return sql.raw(`to_char((${alias}.${tsCol} AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')`);
}

interface RawRow {
  bucket: string;
  calls_logged: unknown;
  calls_inbound: unknown;
  calls_outbound: unknown;
  calls_by_outcome: unknown;
  calls_missed: unknown;
  voicemails: unknown;
  emails_sent: unknown;
  emails_received: unknown;
  sms_sent: unknown;
  sms_received: unknown;
  notes_added: unknown;
  tasks_completed: unknown;
  talk_time_seconds: unknown;
}

function toInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Coerce a `jsonb_object_agg` result (object or JSON text) into a count map. */
function parseOutcomeMap(value: unknown): Record<string, number> {
  let obj: unknown = value;
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (obj === null || typeof obj !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = toInt(v);
  return out;
}

function mapRow(row: RawRow): ActivityReportRow {
  return {
    bucket: String(row.bucket),
    callsLogged: toInt(row.calls_logged),
    callsInbound: toInt(row.calls_inbound),
    callsOutbound: toInt(row.calls_outbound),
    callsByOutcome: parseOutcomeMap(row.calls_by_outcome),
    callsMissed: toInt(row.calls_missed),
    voicemails: toInt(row.voicemails),
    emailsSent: toInt(row.emails_sent),
    emailsReceived: toInt(row.emails_received),
    smsSent: toInt(row.sms_sent),
    smsReceived: toInt(row.sms_received),
    notesAdded: toInt(row.notes_added),
    tasksCompleted: toInt(row.tasks_completed),
    talkTimeSeconds: toInt(row.talk_time_seconds),
  };
}

/**
 * Run the activity report. Resolves the date range (throws `ReportRangeError`
 * on a bad/oversized range) and decodes the cursor (throws `InvalidCursorError`)
 * — both mapped to `VALIDATION_FAILED` by the route.
 */
export async function runActivityReport(
  db: Db,
  query: ActivityQuery,
): Promise<ReportPage<ActivityReportRow>> {
  const range = resolveRange(query.from, query.to);
  const limit = clampLimit(query.limit);
  const mode = query.groupBy;
  const uid = query.userId ?? null;
  const cursorBucket = query.cursor !== undefined ? decodeCursorTuple(query.cursor, ['string'])[0] : null;

  const from = range.fromTs;
  const to = range.toExclusiveTs;

  // `user` mode buckets on the rep id, so null-rep rows are unattributable.
  const evUserGuard = mode === 'user' ? sql`AND a.user_id IS NOT NULL` : sql``;
  const calUserGuard = mode === 'user' ? sql`AND c.user_id IS NOT NULL` : sql``;
  // A `userId` filter always surfaces that rep (zero-activity → all-zero row).
  const userSeed =
    mode === 'user' && uid !== null
      ? sql`UNION SELECT id::text AS bucket FROM users WHERE id = ${uid}::uuid`
      : sql``;

  const evBucket = bucketRaw(mode, 'a', 'occurred_at');
  const calBucket = bucketRaw(mode, 'c', 'started_at');

  const queryText = sql`
    WITH ev AS (
      SELECT ${evBucket} AS bucket,
             a.type AS type,
             a.payload->>'direction' AS direction,
             coalesce(a.payload->>'outcome', 'unknown') AS outcome
      FROM activities a
      WHERE a.occurred_at >= ${from}::timestamptz
        AND a.occurred_at < ${to}::timestamptz
        ${evUserGuard}
        AND (${uid}::uuid IS NULL OR a.user_id = ${uid}::uuid)
        AND a.type IN (${sql.join(
          REPORTED_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )})
    ),
    agg AS (
      SELECT bucket,
        count(*) FILTER (WHERE type = 'call_logged') AS calls_logged,
        count(*) FILTER (WHERE type = 'call_logged' AND direction = 'inbound') AS calls_inbound,
        count(*) FILTER (WHERE type = 'call_logged' AND direction = 'outbound') AS calls_outbound,
        count(*) FILTER (WHERE type = 'call_missed') AS calls_missed,
        count(*) FILTER (WHERE type = 'voicemail_received') AS voicemails,
        count(*) FILTER (WHERE type = 'email_sent') AS emails_sent,
        count(*) FILTER (WHERE type = 'email_received') AS emails_received,
        count(*) FILTER (WHERE type = 'sms_sent') AS sms_sent,
        count(*) FILTER (WHERE type = 'sms_received') AS sms_received,
        count(*) FILTER (WHERE type = 'note_added') AS notes_added,
        count(*) FILTER (WHERE type = 'task_completed') AS tasks_completed
      FROM ev
      GROUP BY bucket
    ),
    outc AS (
      SELECT bucket, jsonb_object_agg(outcome, c) AS by_outcome
      FROM (
        SELECT bucket, outcome, count(*) AS c
        FROM ev
        WHERE type = 'call_logged'
        GROUP BY bucket, outcome
      ) s
      GROUP BY bucket
    ),
    cal AS (
      SELECT ${calBucket} AS bucket, coalesce(sum(c.duration_s), 0) AS talk
      FROM calls c
      WHERE c.started_at >= ${from}::timestamptz
        AND c.started_at < ${to}::timestamptz
        ${calUserGuard}
        AND (${uid}::uuid IS NULL OR c.user_id = ${uid}::uuid)
      GROUP BY 1
    ),
    keys AS (
      SELECT bucket FROM agg
      UNION SELECT bucket FROM cal
      ${userSeed}
    )
    SELECT k.bucket AS bucket,
      coalesce(agg.calls_logged, 0) AS calls_logged,
      coalesce(agg.calls_inbound, 0) AS calls_inbound,
      coalesce(agg.calls_outbound, 0) AS calls_outbound,
      coalesce(outc.by_outcome, '{}'::jsonb) AS calls_by_outcome,
      coalesce(agg.calls_missed, 0) AS calls_missed,
      coalesce(agg.voicemails, 0) AS voicemails,
      coalesce(agg.emails_sent, 0) AS emails_sent,
      coalesce(agg.emails_received, 0) AS emails_received,
      coalesce(agg.sms_sent, 0) AS sms_sent,
      coalesce(agg.sms_received, 0) AS sms_received,
      coalesce(agg.notes_added, 0) AS notes_added,
      coalesce(agg.tasks_completed, 0) AS tasks_completed,
      coalesce(cal.talk, 0) AS talk_time_seconds
    FROM keys k
    LEFT JOIN agg ON agg.bucket = k.bucket
    LEFT JOIN outc ON outc.bucket = k.bucket
    LEFT JOIN cal ON cal.bucket = k.bucket
    WHERE (${cursorBucket}::text IS NULL OR k.bucket > ${cursorBucket}::text)
    ORDER BY k.bucket ASC
    LIMIT ${limit + 1}
  `;

  const result = await db.execute(queryText);
  const rows = (result as { rows: RawRow[] }).rows.map(mapRow);
  return buildPage(rows, limit, (r) => encodeCursor([r.bucket]));
}
