import type { RawEmail } from '@switchboard/shared/providers';
import { threadTriageValues } from '@switchboard/shared';

/** C1 thread triage states (derived from the shared enum values). */
export type ThreadTriage = (typeof threadTriageValues)[number];

/**
 * Thread → lead matching seam (CONTRACTS §C5 note: "Thread/lead matching may be a
 * stub that leaves triage_status='ambiguous' — 2c owns matching"). The sync
 * engine consumes this interface; 2c ships the real address/participant matcher.
 *
 * A decision is `(triageStatus, leadId)`: `matched` carries a `leadId`, `ambiguous`
 * / `ignored` carry `null`. Keeping it a pure function of the message + existing
 * thread keeps the ingest path deterministic (I-SYNC).
 */

export interface MatchInput {
  accountId: string;
  raw: RawEmail;
  /** Subject with Re:/Fwd: prefixes stripped, lowercased (thread grouping key). */
  subjectNorm: string;
  /** Deduped, sorted participant addresses for the thread. */
  participants: string[];
}

export interface MatchDecision {
  triageStatus: ThreadTriage;
  leadId: string | null;
}

export interface LeadMatcher {
  match(input: MatchInput): MatchDecision;
}

/**
 * Default matcher for 2b: never guesses a lead. Every thread lands in the triage
 * queue as `ambiguous` with no lead — the honest state until 2c's matcher runs.
 */
export class AmbiguousLeadMatcher implements LeadMatcher {
  match(_input: MatchInput): MatchDecision {
    return { triageStatus: 'ambiguous', leadId: null };
  }
}
