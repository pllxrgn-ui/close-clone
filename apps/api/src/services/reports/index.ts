/**
 * Reporting read layer (Task 4g, CONTRACTS §C7 `reports/*`). Three read-only
 * report families over the Postgres truth — activity (per-rep/per-day metrics +
 * talk time), funnel (currency-aware pipeline by stage + stage conversion), and
 * sequences (per-sequence send/reply/bounce/unsubscribe/finish + enrollment
 * snapshot) — each returning a keyset-paginated `{ items, nextCursor? }` page of
 * zod-typed rows. Consumed by the REST route plugin (`registerReportsRoutes`).
 */
export { runActivityReport } from './activity.ts';
export { runFunnelReport } from './funnel.ts';
export { runSequencesReport } from './sequences.ts';

export {
  InvalidCursorError,
  encodeCursor,
  decodeCursor,
  decodeCursorTuple,
  type CursorValue,
} from './cursor.ts';

export {
  ReportRangeError,
  resolveRange,
  clampLimit,
  buildPage,
  reportPageSchema,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
  activityQuerySchema,
  funnelQuerySchema,
  sequencesQuerySchema,
  activityReportRowSchema,
  funnelStageRowSchema,
  sequenceReportRowSchema,
  type ActivityQuery,
  type FunnelQuery,
  type SequencesQuery,
  type ActivityReportRow,
  type FunnelStageRow,
  type SequenceReportRow,
  type ReportPage,
  type ResolvedRange,
} from './schemas.ts';
