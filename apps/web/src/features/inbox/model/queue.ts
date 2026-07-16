import type {
  InboxItem,
  InboxSection,
  InboxSectionId,
  InboxStats,
  ReplyItem,
  ReviewItem,
  TaskItem,
} from './types.ts';
import type { InboxStoreData, StoredReview, StoredTask, StoredThread } from './store.ts';
import { INBOX_NOW_MS, isToday, startOfToday } from './time.ts';

/*
 * The queue merge — the heart of the Inbox. It folds three real sources into one
 * lamp-lit, section-ordered list and derives the header counters. Pure functions
 * over the store snapshot, so the ordering law (overdue → replies-by-recency →
 * reviews) and the counters are exhaustively unit-testable.
 */

function isSnoozed(snoozedUntil: string | null, nowMs: number): boolean {
  return snoozedUntil !== null && Date.parse(snoozedUntil) > nowMs;
}

/** A thread is a live reply row when it is unanswered, un-snoozed and still ahead of the last touch. */
function isOpenReply(thread: StoredThread, nowMs: number): boolean {
  if (thread.answered || isSnoozed(thread.snoozedUntil, nowMs)) return false;
  const inbound = Date.parse(thread.lastInboundAt);
  const contacted = thread.lastContactedAt ? Date.parse(thread.lastContactedAt) : -Infinity;
  return inbound > contacted;
}

/** A task is a live row when it is incomplete, un-snoozed and due (dueAt <= now). */
function isOpenTask(task: StoredTask, nowMs: number): boolean {
  if (task.completedAt !== null || isSnoozed(task.snoozedUntil, nowMs)) return false;
  return Date.parse(task.dueAt) <= nowMs;
}

function isOpenReview(review: StoredReview, nowMs: number): boolean {
  return review.state === 'AWAITING_REVIEW' && !isSnoozed(review.snoozedUntil, nowMs);
}

function toReplyItem(thread: StoredThread, leadNames: Map<string, string>): ReplyItem {
  return {
    kind: 'reply',
    id: `reply:${thread.id}`,
    threadId: thread.id,
    leadId: thread.leadId,
    leadName: leadNames.get(thread.leadId) ?? 'Unknown lead',
    contactId: thread.contactId,
    contactName: thread.contactName,
    toAddress: thread.toAddress,
    channel: thread.channel,
    subject: thread.subject,
    snippet: thread.snippet,
    receivedAt: thread.lastInboundAt,
    lamp: 'reply',
  };
}

function toTaskItem(
  task: StoredTask,
  leadNames: Map<string, string>,
  leadDnc: Map<string, boolean>,
  nowMs: number,
): TaskItem {
  return {
    kind: 'task',
    id: `task:${task.id}`,
    taskId: task.id,
    leadId: task.leadId,
    leadName: leadNames.get(task.leadId) ?? 'Unknown lead',
    title: task.title,
    dueAt: task.dueAt,
    overdue: Date.parse(task.dueAt) < startOfToday(nowMs),
    leadDnc: leadDnc.get(task.leadId) === true,
    lamp: 'overdue',
  };
}

function toReviewItem(review: StoredReview, leadNames: Map<string, string>): ReviewItem {
  return {
    kind: 'review',
    id: `review:${review.id}`,
    intentId: review.id,
    enrollmentId: review.enrollmentId,
    leadId: review.leadId,
    leadName: leadNames.get(review.leadId) ?? 'Unknown lead',
    contactName: review.contactName,
    sequenceName: review.sequenceName,
    channel: review.channel,
    stepLabel: `Step ${review.stepIndex} of ${review.stepCount} · ${labelChannel(review.channel)}`,
    subject: review.subject,
    preview: review.preview,
    dueAt: review.dueAt,
    lamp: 'seq',
  };
}

function labelChannel(channel: 'email' | 'sms'): string {
  return channel === 'email' ? 'Email' : 'SMS';
}

function byAsc(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}
function byDesc(a: string, b: string): number {
  return Date.parse(b) - Date.parse(a);
}

/**
 * Build the merged, ordered queue: overdue tasks first (most overdue first), then
 * replies by recency (newest inbound first), then reviews (longest-waiting first).
 * Ties break by id for a stable order.
 */
export function buildQueue(data: InboxStoreData, nowMs: number = INBOX_NOW_MS): InboxItem[] {
  const tasks = [...data.tasks.values()]
    .filter((t) => isOpenTask(t, nowMs))
    .map((t) => toTaskItem(t, data.leadNames, data.leadDnc, nowMs))
    .sort((a, b) => byAsc(a.dueAt, b.dueAt) || (a.id < b.id ? -1 : 1));

  const replies = [...data.threads.values()]
    .filter((t) => isOpenReply(t, nowMs))
    .map((t) => toReplyItem(t, data.leadNames))
    .sort((a, b) => byDesc(a.receivedAt, b.receivedAt) || (a.id < b.id ? -1 : 1));

  const reviews = [...data.reviews.values()]
    .filter((r) => isOpenReview(r, nowMs))
    .map((r) => toReviewItem(r, data.leadNames))
    .sort((a, b) => byAsc(a.dueAt, b.dueAt) || (a.id < b.id ? -1 : 1));

  return [...tasks, ...replies, ...reviews];
}

const SECTION_LABEL: Record<InboxSectionId, string> = {
  overdue: 'Overdue',
  replies: 'Replies',
  reviews: 'Review',
};

/** Group the flat queue into labelled, counted sections (empty sections dropped). */
export function groupSections(items: InboxItem[]): InboxSection[] {
  const buckets: Record<InboxSectionId, InboxItem[]> = { overdue: [], replies: [], reviews: [] };
  for (const item of items) {
    if (item.kind === 'task') buckets.overdue.push(item);
    else if (item.kind === 'reply') buckets.replies.push(item);
    else buckets.reviews.push(item);
  }
  const order: InboxSectionId[] = ['overdue', 'replies', 'reviews'];
  return order
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({ id, label: SECTION_LABEL[id], items: buckets[id] }));
}

/** Count of items cleared today: tasks completed, threads answered, reviews dispositioned. */
export function countDoneToday(data: InboxStoreData, nowMs: number = INBOX_NOW_MS): number {
  let n = 0;
  for (const task of data.tasks.values()) {
    if (task.completedAt !== null && isToday(task.completedAt, nowMs)) n += 1;
  }
  for (const thread of data.threads.values()) {
    if (thread.answered && isToday(thread.answeredAt, nowMs)) n += 1;
  }
  for (const review of data.reviews.values()) {
    if (
      (review.state === 'SENT' || review.state === 'SKIPPED') &&
      isToday(review.dispositionedAt, nowMs)
    ) {
      n += 1;
    }
  }
  return n;
}

/** The three header numerals, derived from one store snapshot. */
export function computeStats(data: InboxStoreData, nowMs: number = INBOX_NOW_MS): InboxStats {
  const items = buildQueue(data, nowMs);
  const overdue = items.filter((it) => it.kind === 'task').length;
  return {
    needsYouNow: items.length,
    overdue,
    doneToday: countDoneToday(data, nowMs),
  };
}

/**
 * The lead's next due task after excluding `excludeTaskId` — the "next_task
 * recompute" that follows completing a task. Returns the due timestamp or null.
 */
export function nextTaskDueFor(
  leadId: string,
  data: InboxStoreData,
  excludeTaskId: string | null = null,
  nowMs: number = INBOX_NOW_MS,
): string | null {
  const candidates = [...data.tasks.values()]
    .filter(
      (t) =>
        t.leadId === leadId &&
        t.id !== excludeTaskId &&
        t.completedAt === null &&
        !isSnoozed(t.snoozedUntil, nowMs),
    )
    .sort((a, b) => byAsc(a.dueAt, b.dueAt));
  return candidates[0]?.dueAt ?? null;
}
