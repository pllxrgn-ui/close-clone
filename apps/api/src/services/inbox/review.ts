import { and, eq, sql } from 'drizzle-orm';
import { contacts, leads, sendIntents, sequenceEnrollments, type Db } from '../../db/index.ts';
import type { QueueDriver } from '../../queue/index.ts';
import { SEND_JOB_NAME, wakeupJobId } from '../sequences/job-names.ts';
import { InboxConflictError, InboxNotFoundError, InboxSuppressedError } from './errors.ts';
import type { ReviewResult } from './types.ts';

/**
 * Review disposition — the C7 home for the `send_intents` AWAITING_REVIEW
 * transition (D-030). This is the human-confirm gate for sequence steps that
 * require review before sending; it never bypasses a compliance rail:
 *
 *   - APPROVE releases the intent to SCHEDULED (due now) so the ONE sanctioned
 *     send path (`services/sequences/dispatch.ts`) claims it and re-checks every
 *     rail (DNC · suppression · window · cap) INSIDE the send transaction. Approve
 *     itself never sends. A DNC lead/contact is refused up front (SUPPRESSED),
 *     mirroring the mock, so a doomed send is not even queued.
 *   - SKIP marks the intent SKIPPED (terminal); a skipped step never sends — always
 *     safe.
 *
 * Both are atomic guards (`WHERE state = 'AWAITING_REVIEW'`): a step already
 * dispositioned (or never in review) is a CONFLICT, never a double-action.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface ReviewDeps {
  now: () => Date;
  /** Optional: enqueue the released intent for immediate dispatch. Absent under a
   *  queue-less dev boot — the intent still becomes SCHEDULED and a worker/sweeper
   *  claims it; the item leaves the inbox either way. */
  queue?: QueueDriver;
}

interface IntentContext {
  state: string;
  leadDnc: boolean;
  contactDnc: boolean;
}

async function loadIntent(db: Db, intentId: string): Promise<IntentContext | null> {
  const rows = await db
    .select({
      state: sendIntents.state,
      leadDnc: leads.dnc,
      contactDnc: contacts.dnc,
    })
    .from(sendIntents)
    .innerJoin(sequenceEnrollments, eq(sequenceEnrollments.id, sendIntents.enrollmentId))
    .innerJoin(leads, eq(leads.id, sequenceEnrollments.leadId))
    .innerJoin(contacts, eq(contacts.id, sequenceEnrollments.contactId))
    .where(eq(sendIntents.id, intentId))
    .limit(1);
  return rows[0] ?? null;
}

/** Approve a step awaiting review → release to send (rails run in dispatch). */
export async function approveReview(
  db: Db,
  intentId: string,
  deps: ReviewDeps,
): Promise<ReviewResult> {
  const ctx = await loadIntent(db, intentId);
  if (ctx === null) throw new InboxNotFoundError('Review step not found');
  if (ctx.state !== 'AWAITING_REVIEW') throw new InboxConflictError();
  // I-DNC pre-check (dispatch is still authoritative and re-checks in the txn).
  if (ctx.leadDnc || ctx.contactDnc) throw new InboxSuppressedError();

  const nowIso = deps.now().toISOString();
  const released = await db
    .update(sendIntents)
    .set({
      state: 'SCHEDULED',
      dueAt: nowIso,
      claimedAt: null,
      workerId: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(sendIntents.id, intentId), eq(sendIntents.state, 'AWAITING_REVIEW')))
    .returning({ id: sendIntents.id });
  if (released.length === 0) throw new InboxConflictError();

  if (deps.queue !== undefined) {
    await deps.queue.enqueue(
      SEND_JOB_NAME,
      { intentId },
      { delayMs: 0, jobId: wakeupJobId(intentId, new Date(nowIso).getTime()) },
    );
  }

  return { id: intentId, state: 'SCHEDULED', disposition: 'approved' };
}

/** Skip a step awaiting review → terminal SKIPPED; never sends. */
export async function skipReview(
  db: Db,
  intentId: string,
  deps: ReviewDeps,
): Promise<ReviewResult> {
  const ctx = await loadIntent(db, intentId);
  if (ctx === null) throw new InboxNotFoundError('Review step not found');
  if (ctx.state !== 'AWAITING_REVIEW') throw new InboxConflictError();

  const skipped = await db
    .update(sendIntents)
    .set({
      state: 'SKIPPED',
      skipReason: 'review_skipped',
      updatedAt: deps.now().toISOString(),
    })
    .where(and(eq(sendIntents.id, intentId), eq(sendIntents.state, 'AWAITING_REVIEW')))
    .returning({ id: sendIntents.id });
  if (skipped.length === 0) throw new InboxConflictError();

  return { id: intentId, state: 'SKIPPED', disposition: 'skipped' };
}
