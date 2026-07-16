import type { InboxChannel } from './types.ts';
import { buildInboxSeed } from './seed.ts';
import { nowIso } from './time.ts';

/*
 * The Inbox's in-memory store — module-scoped Maps seeded from the shared fixture
 * `db`. Every action (reply / complete / approve / skip / snooze) mutates these
 * Maps through the functions below, so the queue and counters visibly change and
 * the writes survive route changes within a session (they reset on a full reload
 * when the module re-initializes). Nothing here reaches outside the feature.
 *
 * Mutations enforce the compliance rails they can (DNC → SUPPRESSED) so the API
 * surface can never be used to bypass them; the HTTP mapping lives in the mock
 * handlers, which translate these typed errors into C8 error bodies.
 */

// ── Stored record shapes (a thin superset of the C1 DTOs the inbox needs) ─────

export interface StoredMessage {
  id: string;
  direction: 'in' | 'out';
  subject: string | null;
  body: string;
  at: string;
}

export interface StoredThread {
  id: string;
  leadId: string;
  contactId: string | null;
  contactName: string;
  channel: InboxChannel;
  toAddress: string;
  subject: string | null;
  snippet: string;
  lastInboundAt: string;
  lastContactedAt: string | null;
  answered: boolean;
  answeredAt: string | null;
  snoozedUntil: string | null;
  messages: StoredMessage[];
}

export interface StoredTask {
  id: string;
  leadId: string;
  title: string;
  dueAt: string;
  completedAt: string | null;
  snoozedUntil: string | null;
}

export type ReviewState = 'AWAITING_REVIEW' | 'SENT' | 'SKIPPED';
export type ReviewDisposition = 'approved' | 'skipped';

export interface StoredReview {
  /** SendIntent id. */
  id: string;
  enrollmentId: string;
  stepId: string;
  sequenceId: string;
  leadId: string;
  contactId: string | null;
  contactName: string;
  sequenceName: string;
  /** 1-based step position and total, for a "Step 2 of 4" label. */
  stepIndex: number;
  stepCount: number;
  channel: InboxChannel;
  subject: string | null;
  preview: string;
  dueAt: string;
  state: ReviewState;
  disposition: ReviewDisposition | null;
  dispositionedAt: string | null;
  snoozedUntil: string | null;
}

export interface InboxStoreData {
  threads: Map<string, StoredThread>;
  tasks: Map<string, StoredTask>;
  reviews: Map<string, StoredReview>;
  leadNames: Map<string, string>;
  leadDnc: Map<string, boolean>;
}

// ── Typed errors → mapped to C8 codes by the handlers ─────────────────────────

/** The referenced item no longer exists (or never did) → NOT_FOUND (404). */
export class InboxNotFoundError extends Error {
  constructor(message = 'Inbox item not found') {
    super(message);
    this.name = 'InboxNotFoundError';
  }
}

/** A send/outreach was attempted against a DNC lead → SUPPRESSED (422). */
export class InboxSuppressedError extends Error {
  constructor(message = 'Recipient is on the do-not-contact list') {
    super(message);
    this.name = 'InboxSuppressedError';
  }
}

// ── The live store instance ───────────────────────────────────────────────────

let data: InboxStoreData = buildInboxSeed();

/** The current store data (read by the queue builder + handlers). */
export function getInboxStore(): InboxStoreData {
  return data;
}

/** Re-seed the store to its deterministic initial state (used by tests). */
export function resetInboxStore(): void {
  data = buildInboxSeed();
}

/** Replace the store contents wholesale (used by tests that need a tiny queue). */
export function loadInboxStore(next: InboxStoreData): void {
  data = next;
}

export function isLeadDnc(leadId: string): boolean {
  return data.leadDnc.get(leadId) === true;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Append an outbound message to a thread and mark it answered. Blocks sends to a
 * DNC lead (compliance rail — CONTRACTS I-DNC / I-SEND-3).
 */
export function applySendReply(
  threadId: string,
  input: { subject: string | null; body: string },
): StoredThread {
  const thread = data.threads.get(threadId);
  if (!thread) throw new InboxNotFoundError('Thread not found');
  if (isLeadDnc(thread.leadId)) throw new InboxSuppressedError();

  const at = nowIso();
  const subject = thread.channel === 'email' ? (input.subject ?? thread.subject) : null;
  thread.messages.push({
    id: crypto.randomUUID(),
    direction: 'out',
    subject,
    body: input.body,
    at,
  });
  thread.answered = true;
  thread.answeredAt = at;
  thread.lastContactedAt = at;
  return thread;
}

/** Check a task off. `completedAt` defaults to the anchored now. */
export function applyCompleteTask(taskId: string, completedAt: string = nowIso()): StoredTask {
  const task = data.tasks.get(taskId);
  if (!task) throw new InboxNotFoundError('Task not found');
  task.completedAt = completedAt;
  return task;
}

/**
 * Approve a sequence step awaiting review → it releases to send. Blocks approval
 * for a DNC lead (the step would be a suppressed send).
 */
export function applyApproveReview(intentId: string, at: string = nowIso()): StoredReview {
  const review = data.reviews.get(intentId);
  if (!review) throw new InboxNotFoundError('Review step not found');
  if (isLeadDnc(review.leadId)) throw new InboxSuppressedError();
  review.state = 'SENT';
  review.disposition = 'approved';
  review.dispositionedAt = at;
  return review;
}

/** Skip a sequence step awaiting review → dispositioned, never sends. Always safe. */
export function applySkipReview(intentId: string, at: string = nowIso()): StoredReview {
  const review = data.reviews.get(intentId);
  if (!review) throw new InboxNotFoundError('Review step not found');
  review.state = 'SKIPPED';
  review.disposition = 'skipped';
  review.dispositionedAt = at;
  return review;
}

export interface SnoozeResult {
  id: string;
  kind: 'reply' | 'task' | 'review';
  snoozedUntil: string;
}

/** Defer a queue row until `until`. Accepts the composite inbox item id. */
export function applySnooze(itemId: string, until: string): SnoozeResult {
  const sep = itemId.indexOf(':');
  const kind = itemId.slice(0, sep);
  const targetId = itemId.slice(sep + 1);
  switch (kind) {
    case 'reply': {
      const thread = data.threads.get(targetId);
      if (!thread) throw new InboxNotFoundError('Thread not found');
      thread.snoozedUntil = until;
      return { id: itemId, kind: 'reply', snoozedUntil: until };
    }
    case 'task': {
      const task = data.tasks.get(targetId);
      if (!task) throw new InboxNotFoundError('Task not found');
      task.snoozedUntil = until;
      return { id: itemId, kind: 'task', snoozedUntil: until };
    }
    case 'review': {
      const review = data.reviews.get(targetId);
      if (!review) throw new InboxNotFoundError('Review step not found');
      review.snoozedUntil = until;
      return { id: itemId, kind: 'review', snoozedUntil: until };
    }
    default:
      throw new InboxNotFoundError(`Unknown inbox item "${itemId}"`);
  }
}
