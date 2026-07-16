/**
 * Inbox projection shapes (CONTRACTS §C7 D-030). These mirror the web's
 * `features/inbox/model/types.ts` field-for-field so `GET /inbox` binds to the
 * same React components when the web flips to the real API — a structural
 * drop-in, re-declared here because the api package cannot import from the web.
 *
 * The queue is a read-only projection (NOT a table): a merge of three real
 * sources — unanswered inbound threads, due/overdue tasks, and sequence steps
 * awaiting review — into one lamp-lit discriminated union.
 */

export type InboxChannel = 'email' | 'sms';

/** An unanswered inbound reply awaiting a response. */
export interface ReplyItem {
  kind: 'reply';
  /** Composite id `reply:<threadId>`. */
  id: string;
  threadId: string;
  leadId: string;
  leadName: string;
  contactId: string | null;
  contactName: string;
  /** Recipient for a reply — the inbound sender's address. */
  toAddress: string;
  channel: InboxChannel;
  subject: string | null;
  snippet: string;
  receivedAt: string;
  lamp: 'reply';
}

/** A task that is due or overdue. */
export interface TaskItem {
  kind: 'task';
  /** Composite id `task:<taskId>`. */
  id: string;
  taskId: string;
  leadId: string;
  leadName: string;
  title: string;
  dueAt: string;
  /** dueAt strictly before the start of today. */
  overdue: boolean;
  leadDnc: boolean;
  lamp: 'overdue';
}

/** A sequence step paused for review before it may send (SendIntent AWAITING_REVIEW). */
export interface ReviewItem {
  kind: 'review';
  /** Composite id `review:<intentId>`. */
  id: string;
  intentId: string;
  enrollmentId: string;
  leadId: string;
  leadName: string;
  contactName: string;
  sequenceName: string;
  channel: InboxChannel;
  /** e.g. "Step 2 of 4 · Email". */
  stepLabel: string;
  subject: string | null;
  preview: string;
  dueAt: string;
  lamp: 'seq';
}

export type InboxItem = ReplyItem | TaskItem | ReviewItem;

/** Header-strip counters. */
export interface InboxStats {
  needsYouNow: number;
  overdue: number;
  doneToday: number;
}

/** `GET /inbox` response — C7 keyset envelope (the projection fits one page). */
export interface InboxQueueResponse {
  items: InboxItem[];
  nextCursor?: string;
}

/** `POST /inbox/reviews/:id/(approve|skip)` response. */
export interface ReviewResult {
  id: string;
  state: string;
  disposition: string | null;
}

/** `POST /inbox/snooze` response. */
export interface SnoozeResult {
  id: string;
  snoozedUntil: string;
}
