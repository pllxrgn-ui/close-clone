import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import {
  activities,
  calls,
  contacts,
  emailThreads,
  leads,
  notes,
  opportunities,
  sendIntents,
  sequenceEnrollments,
  smsMessages,
  tasks,
  type Db,
} from '../db/index.ts';
import { writeAudit, type AuditActorType } from '../services/audit/index.ts';

/**
 * `switchboard-admin hard-delete-lead <id> --reason <text> [--force]` (Task 5g /
 * build guide §5g). Permanently removes a lead and its entire graph in ONE
 * transaction, honoring FK order (children before parents), and records a full
 * audit trail:
 *
 *   - REFUSES without a `--reason` (the CLI exits non-zero).
 *   - REFUSES a lead with open (active/paused) sequence enrollments unless
 *     `--force`; with `--force` those enrollments are unenrolled first.
 *   - Writes `delete.hard_requested` (with a BEFORE snapshot of the lead + child
 *     counts) and, after the deletes, `delete.hard_completed` (with the deleted
 *     counts). Both audit rows live inside the same transaction as the delete, so
 *     the ledger and the data can never disagree.
 *   - Email threads are UNLINKED (`lead_id → null`), not deleted: their messages
 *     are mailbox-owned and outlive the lead. Everything else in the graph is
 *     deleted, leaving zero rows referencing the lead. The lead's search/denorm
 *     state is generated in-row, so deleting the row purges it.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export class HardDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HardDeleteError';
  }
}

/** No `--reason` supplied. The CLI maps this to a non-zero exit. */
export class HardDeleteReasonRequiredError extends HardDeleteError {
  constructor() {
    super('hard-delete requires a non-empty --reason');
    this.name = 'HardDeleteReasonRequiredError';
  }
}

export class HardDeleteLeadNotFoundError extends HardDeleteError {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`lead ${leadId} not found`);
    this.name = 'HardDeleteLeadNotFoundError';
    this.leadId = leadId;
  }
}

/** Lead has open enrollments and `--force` was not given. CLI exits non-zero. */
export class OpenEnrollmentsError extends HardDeleteError {
  readonly leadId: string;
  readonly openCount: number;
  constructor(leadId: string, openCount: number) {
    super(
      `lead ${leadId} has ${openCount} open enrollment(s); re-run with --force to unenroll and delete`,
    );
    this.name = 'OpenEnrollmentsError';
    this.leadId = leadId;
    this.openCount = openCount;
  }
}

export interface HardDeleteActor {
  actorId?: string | null;
  actorType?: AuditActorType;
  ip?: string | null;
}

export interface HardDeleteInput {
  leadId: string;
  reason: string;
  force?: boolean;
  actor?: HardDeleteActor;
}

export interface HardDeleteCounts {
  contacts: number;
  opportunities: number;
  activities: number;
  tasks: number;
  notes: number;
  calls: number;
  sms: number;
  enrollments: number;
  sendIntents: number;
}

export interface HardDeleteResult {
  leadId: string;
  deleted: HardDeleteCounts;
  threadsUnlinked: number;
  unenrolled: number;
  requestedAuditId: string;
  completedAuditId: string;
}

const LIVE_STATES = ['active', 'paused'] as const;

async function countBy(db: Db, table: PgTable, col: PgColumn, value: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(col, value));
  return row?.n ?? 0;
}

export async function hardDeleteLead(db: Db, input: HardDeleteInput): Promise<HardDeleteResult> {
  const reason = input.reason?.trim();
  if (reason === undefined || reason.length === 0) {
    throw new HardDeleteReasonRequiredError();
  }
  const actorType: AuditActorType = input.actor?.actorType ?? 'system';
  const actorId = input.actor?.actorId ?? null;
  const ip = input.actor?.ip ?? null;

  return db.transaction(async (tx) => {
    const [lead] = await tx.select().from(leads).where(eq(leads.id, input.leadId));
    if (!lead) throw new HardDeleteLeadNotFoundError(input.leadId);

    // Refuse (or, with --force, unenroll) open enrollments.
    const openEnrollments = await tx
      .select({ id: sequenceEnrollments.id })
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.leadId, input.leadId),
          inArray(sequenceEnrollments.state, [...LIVE_STATES]),
        ),
      );
    if (openEnrollments.length > 0 && input.force !== true) {
      throw new OpenEnrollmentsError(input.leadId, openEnrollments.length);
    }
    let unenrolled = 0;
    if (openEnrollments.length > 0) {
      await tx
        .update(sequenceEnrollments)
        .set({ state: 'unenrolled', pausedReason: 'hard_delete', updatedAt: sql`now()` })
        .where(
          and(
            eq(sequenceEnrollments.leadId, input.leadId),
            inArray(sequenceEnrollments.state, [...LIVE_STATES]),
          ),
        );
      unenrolled = openEnrollments.length;
    }

    // send_intents have no lead_id — count them via their enrollment so the
    // before-snapshot is accurate (and matches the completed deleted count).
    const [siBefore] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sendIntents)
      .innerJoin(sequenceEnrollments, eq(sendIntents.enrollmentId, sequenceEnrollments.id))
      .where(eq(sequenceEnrollments.leadId, input.leadId));

    // BEFORE snapshot: the lead row + child counts.
    const beforeCounts: HardDeleteCounts = {
      contacts: await countBy(tx, contacts, contacts.leadId, input.leadId),
      opportunities: await countBy(tx, opportunities, opportunities.leadId, input.leadId),
      activities: await countBy(tx, activities, activities.leadId, input.leadId),
      tasks: await countBy(tx, tasks, tasks.leadId, input.leadId),
      notes: await countBy(tx, notes, notes.leadId, input.leadId),
      calls: await countBy(tx, calls, calls.leadId, input.leadId),
      sms: await countBy(tx, smsMessages, smsMessages.leadId, input.leadId),
      enrollments: await countBy(tx, sequenceEnrollments, sequenceEnrollments.leadId, input.leadId),
      sendIntents: siBefore?.n ?? 0,
    };

    const requested = await writeAudit(tx, {
      action: 'delete.hard_requested',
      entity: 'lead',
      entityId: input.leadId,
      actorType,
      actorId,
      ip,
      reason,
      before: { lead: { ...lead }, counts: beforeCounts },
    });

    // --- Delete in FK-safe order (children before parents) -----------------
    const enrollmentIds = (
      await tx
        .select({ id: sequenceEnrollments.id })
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.leadId, input.leadId))
    ).map((r) => r.id);

    let sendIntentsDeleted = 0;
    if (enrollmentIds.length > 0) {
      const si = await tx
        .delete(sendIntents)
        .where(inArray(sendIntents.enrollmentId, enrollmentIds))
        .returning({ id: sendIntents.id });
      sendIntentsDeleted = si.length;
    }

    const enrDeleted = await tx
      .delete(sequenceEnrollments)
      .where(eq(sequenceEnrollments.leadId, input.leadId))
      .returning({ id: sequenceEnrollments.id });
    const actDeleted = await tx
      .delete(activities)
      .where(eq(activities.leadId, input.leadId))
      .returning({ id: activities.id });
    const oppDeleted = await tx
      .delete(opportunities)
      .where(eq(opportunities.leadId, input.leadId))
      .returning({ id: opportunities.id });
    const callDeleted = await tx
      .delete(calls)
      .where(eq(calls.leadId, input.leadId))
      .returning({ id: calls.id });
    const smsDeleted = await tx
      .delete(smsMessages)
      .where(eq(smsMessages.leadId, input.leadId))
      .returning({ id: smsMessages.id });
    const taskDeleted = await tx
      .delete(tasks)
      .where(eq(tasks.leadId, input.leadId))
      .returning({ id: tasks.id });
    const noteDeleted = await tx
      .delete(notes)
      .where(eq(notes.leadId, input.leadId))
      .returning({ id: notes.id });
    // Threads are unlinked, not deleted (mailbox-owned messages reference them).
    const threadsUnlinkedRows = await tx
      .update(emailThreads)
      .set({ leadId: null, updatedAt: sql`now()` })
      .where(eq(emailThreads.leadId, input.leadId))
      .returning({ id: emailThreads.id });
    const contactDeleted = await tx
      .delete(contacts)
      .where(eq(contacts.leadId, input.leadId))
      .returning({ id: contacts.id });
    await tx.delete(leads).where(eq(leads.id, input.leadId));

    const deleted: HardDeleteCounts = {
      contacts: contactDeleted.length,
      opportunities: oppDeleted.length,
      activities: actDeleted.length,
      tasks: taskDeleted.length,
      notes: noteDeleted.length,
      calls: callDeleted.length,
      sms: smsDeleted.length,
      enrollments: enrDeleted.length,
      sendIntents: sendIntentsDeleted,
    };

    const completed = await writeAudit(tx, {
      action: 'delete.hard_completed',
      entity: 'lead',
      entityId: input.leadId,
      actorType,
      actorId,
      ip,
      reason,
      after: { deleted, threadsUnlinked: threadsUnlinkedRows.length, unenrolled },
    });

    return {
      leadId: input.leadId,
      deleted,
      threadsUnlinked: threadsUnlinkedRows.length,
      unenrolled,
      requestedAuditId: requested.id,
      completedAuditId: completed.id,
    };
  });
}
