import { z } from 'zod';
import { sequenceStatusValues } from '@switchboard/shared';

/**
 * Reporting read layer (Task 4g) — response + query contracts, keyset-page
 * envelope, and date-range resolution. These zod schemas are the contract
 * addition the reporting endpoints merge with (CONTRACTS §C7): JSON, camelCase,
 * keyset pagination (`{ items, nextCursor? }`). The TS types are inferred from
 * the schemas, never hand-written (CONTRACTS preamble).
 *
 * Time is UTC-anchored (CONTRACTS §C3): `from`/`to` are calendar dates
 * (`YYYY-MM-DD`) read as UTC, and every date bucket is computed SQL-side with an
 * explicit `AT TIME ZONE 'UTC'`, so a report is independent of the caller's
 * session timezone.
 */

// --- Pagination knobs -------------------------------------------------------

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
/** Max span of a report date range, in days (CONTRACTS acceptance criteria). */
export const MAX_RANGE_DAYS = 366;

const MS_PER_DAY = 86_400_000;

/** Clamp a requested page size into `[1, MAX_LIMIT]`, defaulting when absent. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

// --- Date range -------------------------------------------------------------

/** Thrown when a date range is malformed, inverted, or over the span cap. Maps to VALIDATION_FAILED (§C8). */
export class ReportRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportRangeError';
  }
}

/** A resolved, half-open UTC instant range `[fromTs, toExclusiveTs)` for SQL binding. */
export interface ResolvedRange {
  /** Inclusive lower bound — `from` at 00:00:00 UTC, ISO-8601. */
  fromTs: string;
  /** Exclusive upper bound — the day *after* `to` at 00:00:00 UTC, so `to` is fully included. */
  toExclusiveTs: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` calendar-date string; deeper validation happens in `resolveRange`. */
export const dateStringSchema = z.string().regex(DATE_RE, 'expected a YYYY-MM-DD date');

/** Parse `YYYY-MM-DD` to a UTC-midnight epoch-ms, rejecting non-calendar dates (e.g. 2026-02-30). */
function parseUtcDateMs(value: string): number {
  const m = DATE_RE.exec(value);
  if (m === null) throw new ReportRangeError(`invalid date: ${value}`);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  // Round-trip check: Date.UTC normalises overflow (Feb 30 → Mar 2), so a
  // mismatch means the input was not a real calendar date.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new ReportRangeError(`invalid date: ${value}`);
  }
  return ms;
}

/**
 * Resolve a `from`/`to` calendar-date pair into a half-open UTC instant range.
 * Enforces `from <= to` and a span no larger than `MAX_RANGE_DAYS`. `to` is
 * inclusive by day: the upper bound is the following UTC midnight.
 */
export function resolveRange(from: string, to: string): ResolvedRange {
  const fromMs = parseUtcDateMs(from);
  const toMs = parseUtcDateMs(to);
  if (fromMs > toMs) throw new ReportRangeError('`from` must be on or before `to`');
  const spanDays = (toMs - fromMs) / MS_PER_DAY;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new ReportRangeError(`date range exceeds ${MAX_RANGE_DAYS} days`);
  }
  return {
    fromTs: new Date(fromMs).toISOString(),
    toExclusiveTs: new Date(toMs + MS_PER_DAY).toISOString(),
  };
}

// --- Shared query fragments -------------------------------------------------

const limitSchema = z.coerce.number().int().min(1).max(MAX_LIMIT).optional();
const cursorSchema = z.string().min(1).optional();
const uuidSchema = z.string().uuid();

/** `GET /reports/activity` query string. */
export const activityQuerySchema = z.object({
  from: dateStringSchema,
  to: dateStringSchema,
  userId: uuidSchema.optional(),
  groupBy: z.enum(['user', 'day']).optional().default('user'),
  limit: limitSchema,
  cursor: cursorSchema,
});
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

/**
 * `GET /reports/funnel` query string. `from`/`to` are optional but must appear
 * together — a range scopes won/lost (by close date) and stage-conversion
 * events; omitted, those are all-time. The open pipeline is always the current
 * snapshot.
 */
export const funnelQuerySchema = z
  .object({
    from: dateStringSchema.optional(),
    to: dateStringSchema.optional(),
    currency: z.string().trim().length(3).optional(),
    limit: limitSchema,
    cursor: cursorSchema,
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: '`from` and `to` must be provided together',
    path: ['from'],
  });
export type FunnelQuery = z.infer<typeof funnelQuerySchema>;

/** `GET /reports/sequences` query string. Optional range scopes the event counts. */
export const sequencesQuerySchema = z
  .object({
    sequenceId: uuidSchema.optional(),
    from: dateStringSchema.optional(),
    to: dateStringSchema.optional(),
    limit: limitSchema,
    cursor: cursorSchema,
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: '`from` and `to` must be provided together',
    path: ['from'],
  });
export type SequencesQuery = z.infer<typeof sequencesQuerySchema>;

// --- Response row schemas ---------------------------------------------------

/**
 * One activity-report bucket. `bucket` is the grouping key: a rep's user id when
 * `groupBy=user`, or a `YYYY-MM-DD` UTC date when `groupBy=day`. Call counts come
 * from the `activities` spine (type `call_logged`, split by payload direction and
 * outcome); `talkTimeSeconds` sums `calls.duration_s` (CONTRACTS §C1).
 */
export const activityReportRowSchema = z.object({
  bucket: z.string(),
  callsLogged: z.number().int(),
  callsInbound: z.number().int(),
  callsOutbound: z.number().int(),
  /** outcome label → count, over `call_logged` rows; absent outcome under `"unknown"`. */
  callsByOutcome: z.record(z.string(), z.number().int()),
  callsMissed: z.number().int(),
  voicemails: z.number().int(),
  emailsSent: z.number().int(),
  emailsReceived: z.number().int(),
  smsSent: z.number().int(),
  smsReceived: z.number().int(),
  notesAdded: z.number().int(),
  tasksCompleted: z.number().int(),
  talkTimeSeconds: z.number().int(),
});
export type ActivityReportRow = z.infer<typeof activityReportRowSchema>;

/**
 * One pipeline cell, keyed by `(currency, stage)` — currencies never sum
 * together (CONTRACTS §C1: opportunities carry their own currency). Open metrics
 * are the current active snapshot; won/lost are scoped to the range by close
 * date; entered/exited are `opportunity_stage_changed` events in the range,
 * attributed to this currency via the opportunity.
 */
export const funnelStageRowSchema = z.object({
  currency: z.string(),
  stageId: z.string().uuid(),
  stageLabel: z.string(),
  stageSortOrder: z.number().int(),
  openCount: z.number().int(),
  openValueCents: z.number().int(),
  /** Σ(value_cents × confidence ÷ 100) over open opportunities, rounded to cents. */
  openWeightedValueCents: z.number().int(),
  wonCount: z.number().int(),
  wonValueCents: z.number().int(),
  lostCount: z.number().int(),
  lostValueCents: z.number().int(),
  enteredCount: z.number().int(),
  exitedCount: z.number().int(),
});
export type FunnelStageRow = z.infer<typeof funnelStageRowSchema>;

/**
 * One sequence's performance. Event counts (sends/replies/bounces/unsubscribes/
 * finishes) come from the `activities` spine attributed to the sequence via each
 * event's `enrollmentId`; enrollment counts are the current state snapshot
 * (CONTRACTS §C1/§C4). Replies/bounces/unsubscribes are `sequence_paused` rows by
 * `reason`.
 */
export const sequenceReportRowSchema = z.object({
  sequenceId: z.string().uuid(),
  sequenceName: z.string(),
  sequenceStatus: z.enum(sequenceStatusValues),
  sends: z.number().int(),
  replies: z.number().int(),
  bounces: z.number().int(),
  unsubscribes: z.number().int(),
  finishes: z.number().int(),
  activeEnrollments: z.number().int(),
  pausedEnrollments: z.number().int(),
});
export type SequenceReportRow = z.infer<typeof sequenceReportRowSchema>;

// --- Page envelope ----------------------------------------------------------

/** Keyset page envelope (CONTRACTS §C7): `{ items, nextCursor? }`. */
export interface ReportPage<TRow> {
  items: TRow[];
  nextCursor?: string;
}

/** Build the `reportPageSchema` for a given row schema. */
export function reportPageSchema<TRow extends z.ZodTypeAny>(
  row: TRow,
): z.ZodObject<{ items: z.ZodArray<TRow>; nextCursor: z.ZodOptional<z.ZodString> }> {
  return z.object({ items: z.array(row), nextCursor: z.string().optional() });
}

/**
 * Assemble a keyset page from `limit + 1` fetched rows: trim to `limit` and, when
 * a further row exists, mint the next cursor from the last returned row.
 */
export function buildPage<TRow>(
  rows: TRow[],
  limit: number,
  cursorOf: (row: TRow) => string,
): ReportPage<TRow> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  if (!hasMore) return { items };
  const last = items[items.length - 1];
  if (last === undefined) return { items };
  return { items, nextCursor: cursorOf(last) };
}
