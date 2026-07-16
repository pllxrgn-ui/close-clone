import type { LampState } from '../../../ui/index.ts';

/*
 * Inbox view-model types. The queue is a merge of three real sources — unanswered
 * inbound threads, due/overdue tasks, and sequence steps awaiting review — into a
 * single discriminated union the surface renders as one lamp-lit list.
 *
 * These are UI shapes derived from the C1 domain (Task, EmailThread, SendIntent)
 * plus the denormalized lead columns; the mock returns them from GET /inbox in the
 * C7 `{items, nextCursor?}` envelope, so the same components bind to a real API.
 */

export type InboxChannel = 'email' | 'sms';

/** The three merge sources, in section order (overdue → replies → reviews). */
export type InboxSectionId = 'overdue' | 'replies' | 'reviews';

/** An unanswered inbound reply awaiting a response (lastInboundAt > lastContactedAt). */
export interface ReplyItem {
  kind: 'reply';
  /** Stable composite id: `reply:<threadId>`. */
  id: string;
  threadId: string;
  leadId: string;
  leadName: string;
  contactId: string | null;
  contactName: string;
  /** Recipient for a reply — email address or phone number. */
  toAddress: string;
  channel: InboxChannel;
  /** Present for email threads, null for SMS. */
  subject: string | null;
  /** One-line preview of the latest inbound message. */
  snippet: string;
  /** When the inbound arrived (drives recency sort + age). */
  receivedAt: string;
  lamp: Extract<LampState, 'reply'>;
}

/** A task that is due or overdue (dueAt <= now). */
export interface TaskItem {
  kind: 'task';
  /** Stable composite id: `task:<taskId>`. */
  id: string;
  taskId: string;
  leadId: string;
  leadName: string;
  title: string;
  dueAt: string;
  /** dueAt strictly before now (vs. due earlier today). */
  overdue: boolean;
  /** Lead is on the do-not-contact list — surfaced so completing stays compliance-aware. */
  leadDnc: boolean;
  lamp: Extract<LampState, 'overdue'>;
}

/** A sequence step paused for human review before it may send (SendIntent AWAITING_REVIEW). */
export interface ReviewItem {
  kind: 'review';
  /** Stable composite id: `review:<intentId>`. */
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
  /** One-line preview of the drafted step body. */
  preview: string;
  /** When the step became due for review. */
  dueAt: string;
  lamp: Extract<LampState, 'seq'>;
}

export type InboxItem = ReplyItem | TaskItem | ReviewItem;

/** A rendered section: a labelled, counted run of items of one flavor. */
export interface InboxSection {
  id: InboxSectionId;
  /** Wide-caps label, e.g. "OVERDUE". */
  label: string;
  items: InboxItem[];
}

/** Header-strip counters — the three display numerals that update as you act. */
export interface InboxStats {
  needsYouNow: number;
  overdue: number;
  doneToday: number;
}

/** GET /inbox response — C7 keyset envelope. */
export interface InboxQueueResponse {
  items: InboxItem[];
  nextCursor?: string;
}
