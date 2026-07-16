import type { InboxItem, InboxStats, ReplyItem, ReviewItem, TaskItem } from './types.ts';
import { startOfTodayMs } from './time.ts';

/**
 * The queue merge — pure functions over a loaded snapshot, mirroring the web's
 * `features/inbox/model/queue.ts` so the ordering law and counters are identical:
 *   overdue tasks first (soonest due first) → replies by recency (newest first) →
 *   reviews (longest-waiting first). Ties break by composite id for stability.
 *
 * Kept pure (no DB, no clock) so the exact math is unit-testable against
 * hand-built rows; the loader (`load.ts`) supplies real rows from Postgres.
 */

// --- Snapshot row shapes (what the loader produces) ------------------------

export interface TaskRow {
  taskId: string;
  leadId: string;
  leadName: string;
  title: string;
  dueAt: string | null;
  completedAt: string | null;
  leadDnc: boolean;
}

export interface ReplyRow {
  threadId: string;
  leadId: string;
  leadName: string;
  contactId: string | null;
  contactName: string;
  toAddress: string;
  subject: string | null;
  snippet: string;
  /** Latest inbound time (drives recency + "answered" comparison). */
  receivedAt: string;
  /** Latest outbound time, or null — a reply is open while receivedAt is newer. */
  lastContactedAt: string | null;
}

export interface ReviewRow {
  intentId: string;
  enrollmentId: string;
  leadId: string;
  leadName: string;
  contactName: string;
  sequenceName: string;
  stepIndex: number;
  stepCount: number;
  channel: 'email' | 'sms';
  subject: string | null;
  preview: string;
  dueAt: string;
  /** send_intent state — the queue shows only AWAITING_REVIEW. */
  state: string;
}

export interface OpenSnapshot {
  tasks: TaskRow[];
  replies: ReplyRow[];
  reviews: ReviewRow[];
}

/** A cleared-item timestamp (completed task / answered thread / dispositioned review). */
export interface DoneCandidate {
  at: string | null;
}

// --- Filters (mirror the web predicates) -----------------------------------

function isOpenTask(t: TaskRow, nowMs: number): boolean {
  if (t.completedAt !== null || t.dueAt === null) return false;
  return Date.parse(t.dueAt) <= nowMs;
}

function isOpenReply(r: ReplyRow): boolean {
  const inbound = Date.parse(r.receivedAt);
  if (Number.isNaN(inbound)) return false;
  const contacted = r.lastContactedAt !== null ? Date.parse(r.lastContactedAt) : -Infinity;
  return inbound > contacted;
}

function isOpenReview(r: ReviewRow): boolean {
  return r.state === 'AWAITING_REVIEW';
}

// --- Item builders ----------------------------------------------------------

function labelChannel(channel: 'email' | 'sms'): string {
  return channel === 'email' ? 'Email' : 'SMS';
}

function toTaskItem(t: TaskRow, nowMs: number): TaskItem {
  return {
    kind: 'task',
    id: `task:${t.taskId}`,
    taskId: t.taskId,
    leadId: t.leadId,
    leadName: t.leadName,
    title: t.title,
    dueAt: t.dueAt as string,
    overdue: Date.parse(t.dueAt as string) < startOfTodayMs(nowMs),
    leadDnc: t.leadDnc,
    lamp: 'overdue',
  };
}

function toReplyItem(r: ReplyRow): ReplyItem {
  return {
    kind: 'reply',
    id: `reply:${r.threadId}`,
    threadId: r.threadId,
    leadId: r.leadId,
    leadName: r.leadName,
    contactId: r.contactId,
    contactName: r.contactName,
    toAddress: r.toAddress,
    channel: 'email',
    subject: r.subject,
    snippet: r.snippet,
    receivedAt: r.receivedAt,
    lamp: 'reply',
  };
}

function toReviewItem(r: ReviewRow): ReviewItem {
  return {
    kind: 'review',
    id: `review:${r.intentId}`,
    intentId: r.intentId,
    enrollmentId: r.enrollmentId,
    leadId: r.leadId,
    leadName: r.leadName,
    contactName: r.contactName,
    sequenceName: r.sequenceName,
    channel: r.channel,
    stepLabel: `Step ${r.stepIndex} of ${r.stepCount} · ${labelChannel(r.channel)}`,
    subject: r.subject,
    preview: r.preview,
    dueAt: r.dueAt,
    lamp: 'seq',
  };
}

// --- Sort comparators -------------------------------------------------------

function byAsc(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}
function byDesc(a: string, b: string): number {
  return Date.parse(b) - Date.parse(a);
}
function tieId(a: string, b: string): number {
  return a < b ? -1 : 1;
}

/**
 * Build the merged, ordered queue: overdue tasks (soonest first), then replies
 * (newest first), then reviews (longest-waiting first). Ties break by id.
 */
export function buildQueue(open: OpenSnapshot, nowMs: number): InboxItem[] {
  const tasks = open.tasks
    .filter((t) => isOpenTask(t, nowMs))
    .map((t) => toTaskItem(t, nowMs))
    .sort((a, b) => byAsc(a.dueAt, b.dueAt) || tieId(a.id, b.id));

  const replies = open.replies
    .filter((r) => isOpenReply(r))
    .map((r) => toReplyItem(r))
    .sort((a, b) => byDesc(a.receivedAt, b.receivedAt) || tieId(a.id, b.id));

  const reviews = open.reviews
    .filter((r) => isOpenReview(r))
    .map((r) => toReviewItem(r))
    .sort((a, b) => byAsc(a.dueAt, b.dueAt) || tieId(a.id, b.id));

  return [...tasks, ...replies, ...reviews];
}

/** Count of items cleared today (the loader pre-filters to plausible candidates). */
export function countDoneToday(done: DoneCandidate[], nowMs: number): number {
  const lo = startOfTodayMs(nowMs);
  const hi = lo + 24 * 60 * 60 * 1000;
  let n = 0;
  for (const c of done) {
    if (c.at === null) continue;
    const t = Date.parse(c.at);
    if (!Number.isNaN(t) && t >= lo && t < hi) n += 1;
  }
  return n;
}

/** The three header numerals, derived from the open snapshot + done candidates. */
export function computeStats(open: OpenSnapshot, done: DoneCandidate[], nowMs: number): InboxStats {
  const items = buildQueue(open, nowMs);
  const overdue = items.filter((it) => it.kind === 'task').length;
  return {
    needsYouNow: items.length,
    overdue,
    doneToday: countDoneToday(done, nowMs),
  };
}
