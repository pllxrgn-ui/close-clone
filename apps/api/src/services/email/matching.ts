import { and, eq, sql } from 'drizzle-orm';
import { emailAccounts, emailThreads, type Db } from '../../db/index.ts';
import type { LeadMatcher, MatchDecision, MatchInput } from '../sync/matcher.ts';

/**
 * Thread → lead matching (task 2c, CONTRACTS §C5).
 *
 * A thread is matched to a lead by its PARTICIPANTS: every participant email is
 * looked up against `contacts.emails`, and the DISTINCT set of owning leads is
 * collected. The rule (never-guess):
 *   - exactly one candidate lead  → `matched`, that lead;
 *   - zero or ≥2 candidate leads   → `ambiguous`, queued for human triage.
 *
 * Matching is a pure function of the participant set + the current contacts/leads
 * rows, so re-running it over unchanged data yields the same decision (idempotent).
 * It reads only `contacts`/`leads` (live rows) and the mailbox address, so it runs
 * unchanged under `MOCK_MODE=1`.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** Build a `text[]` SQL literal from string params (safe: each is bound). */
function textArray(values: string[]): ReturnType<typeof sql> {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/** The mailbox's own address (lowercased), so it is never matched to a contact. */
async function accountAddress(exec: Db, accountId: string): Promise<string | null> {
  const rows = await exec
    .select({ address: emailAccounts.address })
    .from(emailAccounts)
    .where(eq(emailAccounts.id, accountId))
    .limit(1);
  const found = rows[0];
  return found === undefined ? null : found.address.toLowerCase();
}

/**
 * Distinct LIVE lead ids owning a contact whose email is one of `participants`
 * (case-insensitive). The mailbox's own address is excluded so the rep never
 * matches themselves. Soft-deleted contacts and leads are excluded. Result is
 * sorted for determinism.
 */
export async function findCandidateLeadIds(
  exec: Db,
  accountId: string,
  participants: string[],
): Promise<string[]> {
  const own = await accountAddress(exec, accountId);
  const needles = [
    ...new Set(
      participants
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p.length > 0 && p !== own),
    ),
  ];
  if (needles.length === 0) return [];

  const result = await exec.execute(sql`
    SELECT DISTINCT c.lead_id AS lead_id
    FROM contacts c
    JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
    WHERE c.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(c.emails) AS e
        WHERE lower(e->>'email') = ANY(${textArray(needles)})
      )
    ORDER BY c.lead_id ASC
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  return rows.map((r) => String(r['lead_id']));
}

/** Turn a candidate-lead set into a decision (never guesses on 0 or ≥2). */
export function decideMatch(candidateLeadIds: string[]): MatchDecision {
  if (candidateLeadIds.length === 1) {
    return { triageStatus: 'matched', leadId: candidateLeadIds[0]! };
  }
  return { triageStatus: 'ambiguous', leadId: null };
}

/**
 * The real matcher wired into production ingest. Resolves candidate leads from the
 * thread's participants and applies the never-guess rule.
 */
export class ParticipantLeadMatcher implements LeadMatcher {
  async match(exec: Db, input: MatchInput): Promise<MatchDecision> {
    const candidates = await findCandidateLeadIds(exec, input.accountId, input.participants);
    return decideMatch(candidates);
  }
}

export interface ThreadMatchResult {
  triageStatus: 'matched' | 'ambiguous' | 'ignored';
  leadId: string | null;
  /** True iff this call moved the thread from ambiguous → matched. */
  transitionedToMatched: boolean;
}

/**
 * Re-evaluate a thread's triage decision using the injected matcher, then persist
 * it. The decision LATCHES to protect already-written activities (CONTRACTS §C4
 * exactly-once) and human triage:
 *   - `ignored`  → sticky (a human said "not a lead"); never auto-changed.
 *   - `matched`  → sticky to its lead; a grown participant set never un-matches or
 *     re-points it (that is the human's job via the triage queue).
 *   - `ambiguous`→ run the matcher on the current participants; promote to
 *     `matched` if exactly one lead now resolves, else stay ambiguous.
 *
 * This one-way (ambiguous → matched) latch keeps matching idempotent and
 * order-independent for the realistic cases (0-lead and 1-lead participant sets):
 * whatever order a thread's messages arrive, it ends matched to the same single
 * lead (or stays ambiguous), and no already-emitted activity is ever stranded.
 */
export async function refreshThreadMatch(
  exec: Db,
  matcher: LeadMatcher,
  accountId: string,
  threadId: string,
): Promise<ThreadMatchResult> {
  const rows = await exec
    .select({
      triageStatus: emailThreads.triageStatus,
      leadId: emailThreads.leadId,
      participants: emailThreads.participants,
    })
    .from(emailThreads)
    .where(eq(emailThreads.id, threadId))
    .limit(1);
  const thread = rows[0];
  if (thread === undefined) {
    throw new Error(`refreshThreadMatch: thread ${threadId} not found`);
  }

  if (thread.triageStatus === 'ignored') {
    return { triageStatus: 'ignored', leadId: null, transitionedToMatched: false };
  }
  if (thread.triageStatus === 'matched') {
    return { triageStatus: 'matched', leadId: thread.leadId, transitionedToMatched: false };
  }

  const participants = (thread.participants as unknown[]).map((p) => String(p));
  const decision = await matcher.match(exec, { accountId, participants });
  if (decision.triageStatus !== 'matched' || decision.leadId === null) {
    return { triageStatus: 'ambiguous', leadId: null, transitionedToMatched: false };
  }

  await exec
    .update(emailThreads)
    .set({ triageStatus: 'matched', leadId: decision.leadId, updatedAt: sql`now()` })
    .where(and(eq(emailThreads.id, threadId), eq(emailThreads.triageStatus, 'ambiguous')));

  return { triageStatus: 'matched', leadId: decision.leadId, transitionedToMatched: true };
}
