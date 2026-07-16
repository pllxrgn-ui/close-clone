/**
 * Inbox services (CONTRACTS §C7 D-030): the rep's home queue as a real server-side
 * projection over `email_threads`/`email_messages` (unanswered replies), `tasks`
 * (due/overdue), and `send_intents` (AWAITING_REVIEW) — replacing the MVP's
 * MSW/dev-only story. Reads are pure over a loaded snapshot; the review actions
 * are rail-safe (approve releases to the sanctioned dispatch path, skip is
 * terminal); snooze is a non-persisted next-day acknowledgment (D-030).
 */

export type {
  InboxChannel,
  InboxItem,
  InboxQueueResponse,
  InboxStats,
  ReplyItem,
  ReviewItem,
  ReviewResult,
  SnoozeResult,
  TaskItem,
} from './types.ts';

export {
  buildQueue,
  computeStats,
  countDoneToday,
  type DoneCandidate,
  type OpenSnapshot,
  type ReplyRow,
  type ReviewRow,
  type TaskRow,
} from './model.ts';

export { loadOpenSnapshot, loadDoneCandidates } from './load.ts';

export { approveReview, skipReview, type ReviewDeps } from './review.ts';
export { computeSnooze } from './snooze.ts';

export {
  InboxError,
  InboxNotFoundError,
  InboxSuppressedError,
  InboxConflictError,
} from './errors.ts';
