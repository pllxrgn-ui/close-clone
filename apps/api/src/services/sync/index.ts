/**
 * Mailbox sync engine (CONTRACTS §C5, ARCHITECTURE §3/§5). Provider-agnostic:
 * every worker consumes the `EmailProvider` interface, so MockEmailProvider (2a)
 * or GmailEmailProvider (2b) drive the same code. Pure service functions callable
 * without a queue — 2e's QueueDriver wires the wake-ups.
 */

export { SyncStateService, isLegalTransition, type TransitionResult } from './state.ts';
export {
  SyncError,
  AccountNotFoundError,
  IllegalTransitionError,
  ReauthRequiredError,
  type SyncStatus,
} from './errors.ts';
export { TokenCipher, TokenDecryptError } from './token-cipher.ts';
export {
  AmbiguousLeadMatcher,
  type LeadMatcher,
  type MatchInput,
  type MatchDecision,
  type ThreadTriage,
} from './matcher.ts';
export {
  ingestMessage,
  messageExists,
  normalizeSubject,
  threadParticipants,
  type IngestDeps,
  type IngestResult,
} from './ingest.ts';
export {
  loadAccount,
  backfillCheckpointSchema,
  type SyncEngineDeps,
  type BackfillCheckpoint,
  type LoadedAccount,
} from './engine-deps.ts';
export {
  backfillStep,
  runBackfill,
  type BackfillStepResult,
  type BackfillOptions,
} from './backfill.ts';
export { incrementalPull, type PullResult } from './incremental.ts';
export {
  parseGmailPush,
  persistGmailPush,
  processGmailInboxRow,
  gmailPushSchema,
  gmailNotificationSchema,
  GooglePubSubPushVerifier,
  MockGmailPushVerifier,
  InvalidPushError,
  type GmailPush,
  type GmailNotification,
  type ParsedGmailPush,
  type GmailPushVerifier,
  type PersistResult,
  type ProcessResult,
} from './webhook.ts';
export {
  startLinking,
  completeLinking,
  type LinkingDeps,
  type StartLinkingInput,
  type StartLinkingResult,
  type CompleteLinkingInput,
} from './linking.ts';
