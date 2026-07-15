import { threadTriageValues } from '@switchboard/shared';
import type { Db } from '../../db/index.ts';

/** C1 thread triage states (derived from the shared enum values). */
export type ThreadTriage = (typeof threadTriageValues)[number];

/**
 * Thread → lead matching seam. The ingest path (via 2c's threading service) asks
 * the injected matcher for a decision on a thread's participant set; 2c ships the
 * real address/participant matcher (`ParticipantLeadMatcher`, in
 * `services/email/matching.ts`). Keeping this a small interface lets the base sync
 * suites run with the null-object `AmbiguousLeadMatcher` (no contacts ⇒ nothing to
 * match) while production wires the real one.
 *
 * `match` takes the transaction executor because matching reads `contacts`; it
 * runs inside the same ingest transaction as the message write so the decision and
 * the thread row commit atomically (I-SYNC).
 *
 * A decision is `(triageStatus, leadId)`: `matched` carries a `leadId`, `ambiguous`
 * carries `null`. The matcher NEVER guesses — zero or multiple candidate leads are
 * reported as `ambiguous` for human triage (CONTRACTS §C5 / task 2c).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface MatchInput {
  accountId: string;
  /** Deduped participant email addresses for the thread. */
  participants: string[];
}

export interface MatchDecision {
  triageStatus: ThreadTriage;
  leadId: string | null;
}

export interface LeadMatcher {
  match(exec: Db, input: MatchInput): Promise<MatchDecision>;
}

/**
 * Default matcher: never guesses a lead. Every thread it is asked about is
 * `ambiguous` with no lead — the honest state for the base sync suites, which seed
 * no contacts. Production ingest injects `ParticipantLeadMatcher` instead.
 */
export class AmbiguousLeadMatcher implements LeadMatcher {
  async match(_exec: Db, _input: MatchInput): Promise<MatchDecision> {
    return { triageStatus: 'ambiguous', leadId: null };
  }
}
