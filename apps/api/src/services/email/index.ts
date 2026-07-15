/**
 * Email threading, thread→lead matching, and the ambiguity triage queue
 * (task 2c, CONTRACTS §C1/§C4/§C5). The three ingest-side services
 * (threading/matching/activities) are the seam `services/sync/ingest.ts` calls on
 * every first-sighting message; the triage service is the human side — the queue
 * of ambiguous threads and the resolve/ignore actions that attach a lead (and,
 * on attach, materialize the thread's messages as timeline activities).
 */

export {
  normalizeSubject,
  participantsOf,
  threadParticipants,
  computeIdSet,
  resolveThreadForMessage,
} from './threading.ts';
export {
  ParticipantLeadMatcher,
  findCandidateLeadIds,
  decideMatch,
  refreshThreadMatch,
  type ThreadMatchResult,
} from './matching.ts';
export { materializeThreadActivities } from './activities.ts';
export {
  listAmbiguousThreads,
  resolveThreadToLead,
  ignoreThread,
  ThreadNotFoundError,
  TriageLeadNotFoundError,
  TriageConflictError,
  ActorNotAllowedError,
  InvalidTriageCursorError,
  TriageError,
  type AmbiguousThreadSummary,
  type TriageListOptions,
  type TriageListResult,
  type ResolveInput,
  type ResolveResult,
  type IgnoreInput,
  type IgnoreResult,
} from './triage.ts';
