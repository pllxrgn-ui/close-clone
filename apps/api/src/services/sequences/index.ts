/**
 * Sequence engine barrel (task 2e, ARCHITECTURE §4, CONTRACTS §C6). The scheduler,
 * the send transaction (never-events), suppression + unsubscribe, pause-on-
 * reply/bounce, and the sweeper/crash-recovery loop.
 */

export {
  SequenceError,
  SequenceNotFoundError,
  SequenceValidationError,
  EnrollmentLeadNotFoundError,
  EnrollmentContactNotFoundError,
  AlreadyEnrolledError,
  EnrollmentNotFoundError,
} from './errors.ts';

export {
  enrollContacts,
  type EnrollInput,
  type EnrollTarget,
  type EnrolledTarget,
  type SkippedTarget,
  type EnrollResult,
  type EnrollmentDeps,
} from './enrollment.ts';

export {
  processIntent,
  requeueDeferred,
  type DispatchDeps,
  type DispatchResult,
  type DispatchResultKind,
} from './dispatch.ts';

export { registerSequenceWorker, type SequenceWorkerDeps } from './worker.ts';

export {
  sweepDueIntents,
  expireStaleClaims,
  recoverResyncAccounts,
  type SweeperDeps,
} from './sweeper.ts';

export {
  pauseActiveEnrollments,
  pauseOnInboundReply,
  recordBounceAndPause,
  contactsWithEmail,
  type PauseReason,
  type PauseTarget,
  type BounceInput,
} from './pause.ts';

export {
  applyUnsubscribe,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  buildListUnsubscribeHeaders,
  type UnsubscribeHeaderConfig,
  type ApplyUnsubscribeInput,
  type ApplyUnsubscribeResult,
} from './unsubscribe.ts';

export {
  isEmailSuppressed,
  addEmailSuppression,
  type AddSuppressionInput,
  type AddSuppressionResult,
  type SuppressionSource,
} from './suppression.ts';

export {
  parseSendingWindow,
  isInsideWindow,
  minutesUntilOpen,
  resolveWindowTimezone,
  localParts,
  sendingWindowSchema,
  type SendingWindow,
} from './window.ts';

export { SEND_JOB_NAME, wakeupJobId } from './job-names.ts';
