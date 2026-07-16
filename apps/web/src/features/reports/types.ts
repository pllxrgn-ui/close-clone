/*
 * Reporting DTOs for the web client (S4). These mirror the REAL API's response
 * shapes 1:1 — apps/api/src/services/reports/schemas.ts is the contract — so the
 * same components + MSW handlers work unchanged against real mode later
 * (CONTRACTS §C7: JSON, camelCase, keyset `{items,nextCursor?}`). Domain enums
 * come from @switchboard/shared; nothing here is hand-invented.
 */
import type { Page } from '../../api/client.ts';

export type { Page };

/** A calendar date range, inclusive by day. `from`/`to` are `YYYY-MM-DD` (UTC). */
export interface DateRange {
  from: string;
  to: string;
}

// ── Activity report ─────────────────────────────────────────────────────────

export type ActivityGroupBy = 'user' | 'day';

/** `GET /reports/activity` query. `from`/`to` required; the rest optional. */
export interface ActivityQuery extends DateRange {
  userId?: string;
  groupBy?: ActivityGroupBy;
  limit?: number;
  cursor?: string;
}

/**
 * One activity bucket. `bucket` is the grouping key — a user id (`groupBy=user`)
 * or a `YYYY-MM-DD` UTC day (`groupBy=day`). Mirrors `activityReportRowSchema`.
 */
export interface ActivityReportRow {
  bucket: string;
  callsLogged: number;
  callsInbound: number;
  callsOutbound: number;
  /** outcome label → count over `call_logged` rows (absent outcome → `unknown`). */
  callsByOutcome: Record<string, number>;
  callsMissed: number;
  voicemails: number;
  emailsSent: number;
  emailsReceived: number;
  smsSent: number;
  smsReceived: number;
  notesAdded: number;
  tasksCompleted: number;
  talkTimeSeconds: number;
}

// ── Funnel / pipeline report ────────────────────────────────────────────────

/** `GET /reports/funnel` query. `from`/`to` optional but must appear together. */
export interface FunnelQuery {
  from?: string;
  to?: string;
  currency?: string;
  limit?: number;
  cursor?: string;
}

/** One pipeline cell keyed by `(currency, stage)`. Mirrors `funnelStageRowSchema`. */
export interface FunnelStageRow {
  currency: string;
  stageId: string;
  stageLabel: string;
  stageSortOrder: number;
  openCount: number;
  openValueCents: number;
  /** Σ(value_cents × confidence ÷ 100) over open opportunities, rounded to cents. */
  openWeightedValueCents: number;
  wonCount: number;
  wonValueCents: number;
  lostCount: number;
  lostValueCents: number;
  enteredCount: number;
  exitedCount: number;
}

// ── Sequence performance report ─────────────────────────────────────────────

/** Matches @switchboard/shared `sequenceStatusValues` (`sequences.status`, C1). */
export type SequenceStatus = 'active' | 'archived';

/** `GET /reports/sequences` query. `from`/`to` optional but must appear together. */
export interface SequencesQuery {
  sequenceId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

/** One sequence's performance. Mirrors `sequenceReportRowSchema`. */
export interface SequenceReportRow {
  sequenceId: string;
  sequenceName: string;
  sequenceStatus: SequenceStatus;
  sends: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
  finishes: number;
  activeEnrollments: number;
  pausedEnrollments: number;
}
