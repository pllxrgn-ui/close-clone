import { and, eq, inArray, sql } from 'drizzle-orm';
import { sequencePausedReasonSchema, type ActivityType } from '@switchboard/shared';
import { sequenceEnrollments, type Db } from '../../db/index.ts';
import { recordActivity, type ActivityWebhookEmitter } from '../activity/index.ts';

/**
 * Enrollment pause — the reply/bounce/unsubscribe side of the send-safety rails
 * (CONTRACTS §C6 I-SEND-2, ARCHITECTURE §4.4).
 *
 * The pause TAKES A ROW LOCK on each affected `sequence_enrollments` row
 * (`SELECT … FOR UPDATE`). The send transaction locks the same row before it
 * re-checks state, so the two serialise at the DB level: a pause committed before
 * the send's re-check is seen (send SKIPs); a send holding the lock forces the
 * pause to wait. This closes the reply-vs-send race at the serialization level,
 * not by timing (I-SEND-2).
 *
 * Idempotent + exactly-once: only an `active` enrollment transitions to `paused`
 * and emits exactly one `sequence_paused` event (CONTRACTS §C4). A second pause of
 * an already-paused/finished enrollment is a no-op (no duplicate event).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type PauseReason = 'reply' | 'bounce' | 'manual' | 'unsubscribe';

export interface PauseTarget {
  leadId: string;
  /** Narrow to one contact's enrollments (bounce/unsubscribe); omit for all
   *  active enrollments on the lead (a human reply stops the whole outreach). */
  contactId?: string;
}

/**
 * Pause every matching `active` enrollment, locking each row first. Returns the
 * ids paused (empty if none were active). Runs on the caller's executor so it
 * commits atomically with whatever triggered it (the inbound message write, the
 * bounce record, the unsubscribe suppression).
 */
export async function pauseActiveEnrollments(
  exec: Db,
  target: PauseTarget,
  reason: PauseReason,
  emitter?: ActivityWebhookEmitter,
): Promise<string[]> {
  const validReason = sequencePausedReasonSchema.parse(reason);

  const filters = [
    eq(sequenceEnrollments.leadId, target.leadId),
    eq(sequenceEnrollments.state, 'active'),
  ];
  if (target.contactId !== undefined) {
    filters.push(eq(sequenceEnrollments.contactId, target.contactId));
  }

  // Lock the candidate rows so a concurrent send transaction serialises behind us.
  const locked = await exec
    .select({ id: sequenceEnrollments.id, contactId: sequenceEnrollments.contactId })
    .from(sequenceEnrollments)
    .where(and(...filters))
    .for('update');
  if (locked.length === 0) return [];

  const ids = locked.map((r) => r.id);
  await exec
    .update(sequenceEnrollments)
    .set({ state: 'paused', pausedReason: validReason, updatedAt: sql`now()` })
    .where(inArray(sequenceEnrollments.id, ids));

  const nowIso = new Date().toISOString();
  const eventType: ActivityType = 'sequence_paused';
  for (const row of locked) {
    await recordActivity(
      exec,
      {
        leadId: target.leadId,
        contactId: row.contactId,
        type: eventType,
        occurredAt: nowIso,
        payload: { enrollmentId: row.id, reason: validReason },
      },
      emitter,
    );
  }
  return ids;
}

/**
 * Inbound-reply seam (wired into `services/sync/ingest.ts`): a first-sighting
 * inbound email matched to a lead pauses that lead's active enrollments. Any human
 * reply stops the automated outreach (CONTRACTS §C6 I-SEND-2).
 */
export async function pauseOnInboundReply(
  exec: Db,
  leadId: string,
  emitter?: ActivityWebhookEmitter,
): Promise<string[]> {
  return pauseActiveEnrollments(exec, { leadId }, 'reply', emitter);
}

/**
 * Record an inbound bounce and pause the affected contact's enrollments
 * (CONTRACTS §C6 I-SEND-2). Emits `email_bounced` then `sequence_paused(bounce)`.
 * The full DSN-parsing bounce pipeline is a telephony/email-stream follow-up; this
 * is the engine entry a bounce handler calls.
 */
export interface BounceInput {
  leadId: string;
  contactId?: string;
  emailMessageId?: string;
  reason?: string;
}

export async function recordBounceAndPause(
  db: Db,
  input: BounceInput,
  emitter?: ActivityWebhookEmitter,
): Promise<string[]> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const nowIso = new Date().toISOString();
    await recordActivity(
      tx,
      {
        leadId: input.leadId,
        ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
        type: 'email_bounced',
        occurredAt: nowIso,
        payload: {
          ...(input.emailMessageId !== undefined ? { emailMessageId: input.emailMessageId } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
      },
      emitter,
    );
    const targetBase: PauseTarget = { leadId: input.leadId };
    const targetForPause: PauseTarget =
      input.contactId !== undefined ? { ...targetBase, contactId: input.contactId } : targetBase;
    return pauseActiveEnrollments(tx, targetForPause, 'bounce', emitter);
  });
}

/** Look up the contact(s) on a lead whose email matches `address` (unsubscribe). */
export async function contactsWithEmail(
  exec: Db,
  address: string,
): Promise<{ contactId: string; leadId: string }[]> {
  const result = await exec.execute(sql`
    SELECT c.id AS contact_id, c.lead_id AS lead_id
    FROM contacts c
    WHERE c.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(c.emails) e
        WHERE lower(e->>'email') = lower(${address})
      )
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  return rows.map((r) => ({ contactId: String(r['contact_id']), leadId: String(r['lead_id']) }));
}
