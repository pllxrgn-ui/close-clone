import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  activities,
  calls,
  contacts,
  emailThreads,
  leads,
  notes,
  opportunities,
  sequenceEnrollments,
  smsMessages,
  tasks,
  type ContactRow,
  type Db,
  type LeadRow,
} from '../db/index.ts';
import { recordActivity } from '../services/activity/index.ts';
import { writeAudit, type AuditActorType } from '../services/audit/index.ts';

/**
 * `switchboard-admin merge-leads <winnerId> <loserId>` (Task 5g). Folds the
 * loser lead into the winner in ONE transaction:
 *
 *   1. Contacts are deduplicated by email — a loser contact that shares any email
 *      (case-insensitive) with a winner contact is merged INTO that winner
 *      contact (its opportunities/activities/calls/sms/enrollments re-point to the
 *      survivor, then it is soft-deleted and reported); otherwise it is
 *      re-parented. This is the "UNIQUE collision (same contact email)" the merge
 *      resolves deterministically (winner's contact, earliest created, wins).
 *   2. All remaining lead-scoped children (opportunities, activities, tasks,
 *      notes, email threads, enrollments, calls, sms) re-parent to the winner.
 *   3. A single `lead_merged` timeline event is written via the ActivityWriter,
 *      the winner's denorm last-touch columns absorb the loser's, and an
 *      `lead.merged` audit row records the operation.
 *   4. The loser is soft-deleted and its denorm hot columns are nulled ("dead").
 *
 * CONTRACT FRICTION (reported upward): C1 marks `activities` "append-only, no
 * UPDATE". Merge re-parents `activities.lead_id`/`contact_id` — an out-of-band
 * admin data-custody operation touching only ownership FKs, never event semantics
 * (type/payload/occurred_at). This follows the project's own precedent (D-009:
 * the append-only invariant governs application write paths, not infra/admin ops).
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeError';
  }
}

export class SameLeadError extends MergeError {
  constructor() {
    super('cannot merge a lead into itself');
    this.name = 'SameLeadError';
  }
}

export class MergeLeadNotFoundError extends MergeError {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`lead ${leadId} not found or soft-deleted`);
    this.name = 'MergeLeadNotFoundError';
    this.leadId = leadId;
  }
}

export interface MergeActor {
  actorId?: string | null;
  actorType?: AuditActorType;
  ip?: string | null;
}

export interface MergeLeadsInput {
  winnerId: string;
  loserId: string;
  actor?: MergeActor;
}

export interface DedupedContact {
  loserContactId: string;
  survivingContactId: string;
  matchedEmail: string;
}

export interface UnenrolledCollision {
  enrollmentId: string;
  sequenceId: string;
  survivingContactId: string;
}

export interface ReparentCounts {
  contacts: number;
  opportunities: number;
  activities: number;
  tasks: number;
  notes: number;
  emailThreads: number;
  enrollments: number;
  calls: number;
  sms: number;
}

export interface MergeResult {
  winnerId: string;
  loserId: string;
  reparented: ReparentCounts;
  dedupedContacts: DedupedContact[];
  unenrolledCollisions: UnenrolledCollision[];
  activityId: string;
  auditId: string;
}

const LIVE_STATES = ['active', 'paused'] as const;

function emailsOf(row: ContactRow): string[] {
  return row.emails.map((e) => e.email.trim().toLowerCase()).filter((e) => e.length > 0);
}

/** Deterministic order: earliest created, then id — so dedupe/merge is stable. */
function byCreatedThenId(a: ContactRow, b: ContactRow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function liveLead(db: Db, leadId: string): Promise<LeadRow | undefined> {
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)));
  return row;
}

export async function mergeLeads(db: Db, input: MergeLeadsInput): Promise<MergeResult> {
  if (input.winnerId === input.loserId) throw new SameLeadError();
  const actorType: AuditActorType = input.actor?.actorType ?? 'system';
  const actorId = input.actor?.actorId ?? null;
  const ip = input.actor?.ip ?? null;

  return db.transaction(async (tx) => {
    const winner = await liveLead(tx, input.winnerId);
    if (!winner) throw new MergeLeadNotFoundError(input.winnerId);
    const loser = await liveLead(tx, input.loserId);
    if (!loser) throw new MergeLeadNotFoundError(input.loserId);

    // --- 1. Contacts: dedupe-by-email vs re-parent -------------------------
    const winnerContacts = (
      await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.leadId, input.winnerId), isNull(contacts.deletedAt)))
    ).sort(byCreatedThenId);
    const loserContacts = (
      await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.leadId, input.loserId), isNull(contacts.deletedAt)))
    ).sort(byCreatedThenId);

    // email → surviving (winner) contact id; first contact per email wins.
    const emailToSurvivor = new Map<string, string>();
    for (const c of winnerContacts) {
      for (const email of emailsOf(c)) {
        if (!emailToSurvivor.has(email)) emailToSurvivor.set(email, c.id);
      }
    }

    const dedupedContacts: DedupedContact[] = [];
    const unenrolledCollisions: UnenrolledCollision[] = [];
    let reparentedContacts = 0;
    let enrollmentsMoved = 0;

    for (const lc of loserContacts) {
      let survivor: string | undefined;
      let matchedEmail: string | undefined;
      for (const email of emailsOf(lc)) {
        const found = emailToSurvivor.get(email);
        if (found !== undefined) {
          survivor = found;
          matchedEmail = email;
          break;
        }
      }

      if (survivor === undefined || matchedEmail === undefined) {
        // No collision → re-parent the contact to the winner.
        await tx
          .update(contacts)
          .set({ leadId: input.winnerId, updatedAt: sql`now()` })
          .where(eq(contacts.id, lc.id));
        reparentedContacts += 1;
        continue;
      }

      // Collision → merge lc into `survivor`.
      await tx
        .update(opportunities)
        .set({ contactId: survivor, updatedAt: sql`now()` })
        .where(eq(opportunities.contactId, lc.id));
      await tx
        .update(activities)
        .set({ contactId: survivor })
        .where(eq(activities.contactId, lc.id));
      await tx
        .update(calls)
        .set({ contactId: survivor, updatedAt: sql`now()` })
        .where(eq(calls.contactId, lc.id));
      await tx
        .update(smsMessages)
        .set({ contactId: survivor, updatedAt: sql`now()` })
        .where(eq(smsMessages.contactId, lc.id));

      // Enrollments of lc: re-point to survivor, resolving the (sequence,contact)
      // live-uniqueness collision deterministically (survivor's live enrollment
      // wins; the loser's duplicate is unenrolled).
      const lcEnrollments = await tx
        .select()
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.contactId, lc.id));
      for (const en of lcEnrollments) {
        const isLive = en.state === 'active' || en.state === 'paused';
        if (isLive) {
          const conflict = await tx
            .select({ id: sequenceEnrollments.id })
            .from(sequenceEnrollments)
            .where(
              and(
                eq(sequenceEnrollments.sequenceId, en.sequenceId),
                eq(sequenceEnrollments.contactId, survivor),
                inArray(sequenceEnrollments.state, [...LIVE_STATES]),
              ),
            );
          if (conflict.length > 0) {
            await tx
              .update(sequenceEnrollments)
              .set({
                state: 'unenrolled',
                pausedReason: 'merge_dedupe',
                contactId: survivor,
                leadId: input.winnerId,
                updatedAt: sql`now()`,
              })
              .where(eq(sequenceEnrollments.id, en.id));
            unenrolledCollisions.push({
              enrollmentId: en.id,
              sequenceId: en.sequenceId,
              survivingContactId: survivor,
            });
            enrollmentsMoved += 1;
            continue;
          }
        }
        await tx
          .update(sequenceEnrollments)
          .set({ contactId: survivor, leadId: input.winnerId, updatedAt: sql`now()` })
          .where(eq(sequenceEnrollments.id, en.id));
        enrollmentsMoved += 1;
      }

      // Soft-delete the merged-away loser contact.
      await tx
        .update(contacts)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(contacts.id, lc.id));
      dedupedContacts.push({
        loserContactId: lc.id,
        survivingContactId: survivor,
        matchedEmail,
      });
    }

    // --- 2. Re-parent remaining lead-scoped children -----------------------
    const oppRows = await tx
      .update(opportunities)
      .set({ leadId: input.winnerId, updatedAt: sql`now()` })
      .where(eq(opportunities.leadId, input.loserId))
      .returning({ id: opportunities.id });
    // activities: ownership FK only — event semantics/timestamps stay immutable.
    const actRows = await tx
      .update(activities)
      .set({ leadId: input.winnerId })
      .where(eq(activities.leadId, input.loserId))
      .returning({ id: activities.id });
    const taskRows = await tx
      .update(tasks)
      .set({ leadId: input.winnerId, updatedAt: sql`now()` })
      .where(eq(tasks.leadId, input.loserId))
      .returning({ id: tasks.id });
    const noteRows = await tx
      .update(notes)
      .set({ leadId: input.winnerId, updatedAt: sql`now()` })
      .where(eq(notes.leadId, input.loserId))
      .returning({ id: notes.id });
    const threadRows = await tx
      .update(emailThreads)
      .set({ leadId: input.winnerId, updatedAt: sql`now()` })
      .where(eq(emailThreads.leadId, input.loserId))
      .returning({ id: emailThreads.id });
    const callRows = await tx
      .update(calls)
      .set({ leadId: input.winnerId, updatedAt: sql`now()` })
      .where(eq(calls.leadId, input.loserId))
      .returning({ id: calls.id });
    const smsRows = await tx
      .update(smsMessages)
      .set({ leadId: input.winnerId, updatedAt: sql`now()` })
      .where(eq(smsMessages.leadId, input.loserId))
      .returning({ id: smsMessages.id });
    // Enrollments whose contact was NOT deduped still point at the loser lead.
    const enrRows = await tx
      .update(sequenceEnrollments)
      .set({ leadId: input.winnerId, updatedAt: sql`now()` })
      .where(eq(sequenceEnrollments.leadId, input.loserId))
      .returning({ id: sequenceEnrollments.id });
    enrollmentsMoved += enrRows.length;

    // --- 3. lead_merged timeline event (exactly once) ----------------------
    const mergedActivity = await recordActivity(tx, {
      leadId: input.winnerId,
      userId: actorType === 'user' ? actorId : null,
      type: 'lead_merged',
      occurredAt: new Date(),
      payload: { mergedFromLeadId: input.loserId, mergedIntoLeadId: input.winnerId },
    });

    // --- 3b. Winner denorm absorbs the loser's last-touch + DNC ------------
    await tx
      .update(leads)
      .set({
        lastContactedAt: sql`greatest(${leads.lastContactedAt}, ${loser.lastContactedAt}::timestamptz)`,
        lastInboundAt: sql`greatest(${leads.lastInboundAt}, ${loser.lastInboundAt}::timestamptz)`,
        lastCallAt: sql`greatest(${leads.lastCallAt}, ${loser.lastCallAt}::timestamptz)`,
        lastEmailAt: sql`greatest(${leads.lastEmailAt}, ${loser.lastEmailAt}::timestamptz)`,
        lastSmsAt: sql`greatest(${leads.lastSmsAt}, ${loser.lastSmsAt}::timestamptz)`,
        nextTaskDueAt: sql`(select min(${tasks.dueAt}) from ${tasks} where ${tasks.leadId} = ${input.winnerId} and ${tasks.completedAt} is null)`,
        dnc: sql`${leads.dnc} or ${loser.dnc}`,
        updatedAt: sql`now()`,
      })
      .where(eq(leads.id, input.winnerId));

    const reparented: ReparentCounts = {
      contacts: reparentedContacts,
      opportunities: oppRows.length,
      activities: actRows.length,
      tasks: taskRows.length,
      notes: noteRows.length,
      emailThreads: threadRows.length,
      enrollments: enrollmentsMoved,
      calls: callRows.length,
      sms: smsRows.length,
    };

    // --- 4. Audit + soft-delete the loser ----------------------------------
    const audit = await writeAudit(tx, {
      action: 'lead.merged',
      entity: 'lead',
      entityId: input.winnerId,
      actorType,
      actorId,
      ip,
      before: { loser: { ...loser } },
      after: {
        winnerId: input.winnerId,
        loserId: input.loserId,
        reparented,
        dedupedContacts,
        unenrolledCollisions,
      },
      reason: `merge lead ${input.loserId} into ${input.winnerId}`,
    });

    await tx
      .update(leads)
      .set({
        deletedAt: sql`now()`,
        updatedAt: sql`now()`,
        lastContactedAt: null,
        lastInboundAt: null,
        nextTaskDueAt: null,
        lastCallAt: null,
        lastEmailAt: null,
        lastSmsAt: null,
      })
      .where(eq(leads.id, input.loserId));

    return {
      winnerId: input.winnerId,
      loserId: input.loserId,
      reparented,
      dedupedContacts,
      unenrolledCollisions,
      activityId: mergedActivity.id,
      auditId: audit.id,
    };
  });
}
