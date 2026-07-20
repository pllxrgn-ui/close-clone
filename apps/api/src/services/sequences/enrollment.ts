import { and, asc, eq, sql } from 'drizzle-orm';
import {
  contacts,
  leads,
  sendIntents,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  type Db,
} from '../../db/index.ts';
import { recordActivity, type ActivityWebhookEmitter } from '../activity/index.ts';
import type { QueueDriver } from '../../queue/index.ts';
import { SEND_JOB_NAME, wakeupJobId } from './job-names.ts';
import { SequenceNotFoundError, SequenceValidationError } from './errors.ts';

/**
 * Enrollment (task 2e, ARCHITECTURE §4.1). Enrolling a (lead, contact) creates a
 * `sequence_enrollments` row plus ONE `send_intents` row per step, then emits
 * exactly one `sequence_enrolled` timeline event and enqueues a delayed wake-up
 * per scheduled intent.
 *
 * Intent state at creation:
 *   - a `requires_review` step → `AWAITING_REVIEW` (the claim `WHERE state='SCHEDULED'`
 *     never picks it up, so it can NEVER auto-send — CONTRACTS §C6);
 *   - otherwise `SCHEDULED`, `due_at = enroll time + cumulative step delay`.
 *
 * Bulk: each target is enrolled in its own transaction so one bad/duplicate target
 * (soft-deleted lead, already-enrolled contact — the C1 partial unique) is skipped
 * with a reason rather than failing the batch. Wake-ups are enqueued only AFTER a
 * target's row transaction commits (Postgres is authoritative; the queue is a hint).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface EnrollTarget {
  leadId: string;
  contactId: string;
}

export interface EnrollInput {
  sequenceId: string;
  enrolledBy?: string;
  /** Sending mailbox for the sequence's email steps (required if any exist). */
  emailAccountId?: string;
  targets: EnrollTarget[];
}

export interface EnrolledTarget extends EnrollTarget {
  enrollmentId: string;
}

export interface SkippedTarget extends EnrollTarget {
  reason: string;
}

export interface EnrollResult {
  enrolled: EnrolledTarget[];
  skipped: SkippedTarget[];
}

export interface EnrollmentDeps {
  db: Db;
  queue: QueueDriver;
  /** Injectable clock; enroll time anchors intent due dates. */
  now: () => Date;
  /** Fans sequence_enrolled onto activity.recorded webhooks. */
  emitter?: ActivityWebhookEmitter;
}

interface StepRow {
  id: string;
  type: 'email' | 'call_task' | 'sms';
  delayHours: number;
  requiresReview: boolean;
}

interface ScheduledWakeup {
  intentId: string;
  delayMs: number;
  /** Absolute due time (epoch ms) — scopes the wake-up job id (see wakeupJobId). */
  dueAtMs: number;
}

async function loadSteps(exec: Db, sequenceId: string): Promise<StepRow[]> {
  return exec
    .select({
      id: sequenceSteps.id,
      type: sequenceSteps.type,
      delayHours: sequenceSteps.delayHours,
      requiresReview: sequenceSteps.requiresReview,
    })
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, sequenceId))
    .orderBy(asc(sequenceSteps.sortOrder), asc(sequenceSteps.id));
}

/** Enroll a batch of contacts into a sequence. */
export async function enrollContacts(
  deps: EnrollmentDeps,
  input: EnrollInput,
): Promise<EnrollResult> {
  const { db } = deps;

  const seqRows = await db
    .select({ id: sequences.id, status: sequences.status })
    .from(sequences)
    .where(eq(sequences.id, input.sequenceId))
    .limit(1);
  const seq = seqRows[0];
  if (seq === undefined) throw new SequenceNotFoundError(input.sequenceId);
  if (seq.status !== 'active') {
    throw new SequenceValidationError(`sequence ${input.sequenceId} is archived`);
  }

  const steps = await loadSteps(db, input.sequenceId);
  if (steps.length === 0) {
    throw new SequenceValidationError(`sequence ${input.sequenceId} has no steps`);
  }
  const hasEmailStep = steps.some((s) => s.type === 'email');
  if (hasEmailStep && input.emailAccountId === undefined) {
    throw new SequenceValidationError(
      `sequence ${input.sequenceId} has email steps but no emailAccountId was supplied`,
    );
  }

  const enrolled: EnrolledTarget[] = [];
  const skipped: SkippedTarget[] = [];

  for (const target of input.targets) {
    const outcome = await enrollOne(deps, input, steps, target);
    if (outcome.kind === 'skipped') {
      skipped.push({ ...target, reason: outcome.reason });
      continue;
    }
    enrolled.push({ ...target, enrollmentId: outcome.enrollmentId });
    // Enqueue wake-ups only after the row txn committed.
    for (const w of outcome.wakeups) {
      await deps.queue.enqueue(
        SEND_JOB_NAME,
        { intentId: w.intentId },
        { delayMs: w.delayMs, jobId: wakeupJobId(w.intentId, w.dueAtMs) },
      );
    }
  }

  return { enrolled, skipped };
}

type EnrollOneOutcome =
  | { kind: 'enrolled'; enrollmentId: string; wakeups: ScheduledWakeup[] }
  | { kind: 'skipped'; reason: string };

async function enrollOne(
  deps: EnrollmentDeps,
  input: EnrollInput,
  steps: StepRow[],
  target: EnrollTarget,
): Promise<EnrollOneOutcome> {
  const now = deps.now();
  try {
    return await deps.db.transaction(async (txRaw) => {
      const tx = txRaw as Db;

      const leadRows = await tx
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.id, target.leadId), sql`${leads.deletedAt} is null`))
        .limit(1);
      if (leadRows[0] === undefined) return { kind: 'skipped', reason: 'lead_not_found' };

      const contactRows = await tx
        .select({ id: contacts.id, leadId: contacts.leadId })
        .from(contacts)
        .where(and(eq(contacts.id, target.contactId), sql`${contacts.deletedAt} is null`))
        .limit(1);
      const contact = contactRows[0];
      if (contact === undefined) return { kind: 'skipped', reason: 'contact_not_found' };
      if (contact.leadId !== target.leadId) {
        return { kind: 'skipped', reason: 'contact_lead_mismatch' };
      }

      // Partial-unique pre-check (C1): one live enrollment per (sequence, contact).
      const dupe = await tx
        .select({ id: sequenceEnrollments.id })
        .from(sequenceEnrollments)
        .where(
          and(
            eq(sequenceEnrollments.sequenceId, input.sequenceId),
            eq(sequenceEnrollments.contactId, target.contactId),
            sql`${sequenceEnrollments.state} in ('active', 'paused')`,
          ),
        )
        .limit(1);
      if (dupe[0] !== undefined) return { kind: 'skipped', reason: 'already_enrolled' };

      const enrollmentRows = await tx
        .insert(sequenceEnrollments)
        .values({
          sequenceId: input.sequenceId,
          leadId: target.leadId,
          contactId: target.contactId,
          ...(input.emailAccountId !== undefined ? { emailAccountId: input.emailAccountId } : {}),
          ...(input.enrolledBy !== undefined ? { enrolledBy: input.enrolledBy } : {}),
          state: 'active',
        })
        .returning({ id: sequenceEnrollments.id });
      const enrollmentId = enrollmentRows[0]!.id;

      const wakeups: ScheduledWakeup[] = [];
      let cumulativeHours = 0;
      for (const step of steps) {
        cumulativeHours += step.delayHours;
        const dueMs = now.getTime() + cumulativeHours * 3_600_000;
        const dueIso = new Date(dueMs).toISOString();
        const state = step.requiresReview ? 'AWAITING_REVIEW' : 'SCHEDULED';
        const intentRows = await tx
          .insert(sendIntents)
          .values({
            enrollmentId,
            stepId: step.id,
            channel: step.type,
            dueAt: dueIso,
            state,
          })
          .returning({ id: sendIntents.id });
        const intentId = intentRows[0]!.id;
        if (state === 'SCHEDULED') {
          wakeups.push({ intentId, delayMs: Math.max(0, dueMs - now.getTime()), dueAtMs: dueMs });
        }
      }

      await recordActivity(
        tx,
        {
          leadId: target.leadId,
          contactId: target.contactId,
          ...(input.enrolledBy !== undefined ? { userId: input.enrolledBy } : {}),
          type: 'sequence_enrolled',
          occurredAt: now.toISOString(),
          payload: { enrollmentId, sequenceId: input.sequenceId },
        },
        deps.emitter,
      );

      return { kind: 'enrolled', enrollmentId, wakeups };
    });
  } catch (err) {
    // Partial-unique backstop (concurrent enroll of the same contact).
    if (isUniqueViolation(err)) return { kind: 'skipped', reason: 'already_enrolled' };
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23505') return true;
  const cause = (err as { cause?: unknown }).cause;
  if (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === '23505'
  ) {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('duplicate key value');
}
