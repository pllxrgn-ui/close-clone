import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Task } from '@switchboard/shared';
import { leads, tasks, users, type Db } from '../../db/index.ts';
import { recordActivity, type ActivityWebhookEmitter } from '../activity/index.ts';

/**
 * Tasks CRUD service (CONTRACTS §C7 `tasks`, §C1 schema, §C4 events). The real-API
 * realization of the resource the web drives through MSW — today only
 * `PATCH /tasks/:id` (inbox "complete", body `{ completedAt }`), with the rest of
 * the CRUD surface added per §C7. See CONTRACTS §C7 v1.3.1 note.
 *
 * Events (through the ActivityWriter, in the same transaction):
 *   - POST                              → `task_created`
 *   - PATCH completedAt null → set      → `task_completed`
 * Both event types trigger the writer's recompute of the denormalized
 * `leads.next_task_due_at` (§C4). For the mutations that change the open-task set
 * WITHOUT a C4 event — a due-date change, a reopen (completedAt → null), a delete —
 * this service recomputes `next_task_due_at` itself, in the same transaction, so
 * the denorm never goes stale. That column is a read-model hint, not a compliance
 * rail, so maintaining it directly here is safe (I-RAIL untouched).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

type TaskRow = typeof tasks.$inferSelect;

// --- Errors ----------------------------------------------------------------

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

/** The task id does not exist. Maps to NOT_FOUND (§C8). */
export class TaskNotFoundError extends TaskError {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`task ${taskId} not found`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

/** The target lead is missing or soft-deleted. Maps to NOT_FOUND (§C8). */
export class TaskLeadNotFoundError extends TaskError {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`lead ${leadId} not found or soft-deleted`);
    this.name = 'TaskLeadNotFoundError';
    this.leadId = leadId;
  }
}

/** A referenced FK (assigneeId/createdBy) does not exist. Maps to VALIDATION_FAILED. */
export class InvalidTaskReferenceError extends TaskError {
  readonly field: string;
  readonly value: string;
  constructor(field: string, value: string) {
    super(`invalid ${field}: ${value} does not exist`);
    this.name = 'InvalidTaskReferenceError';
    this.field = field;
    this.value = value;
  }
}

// --- Serialization (DB row → §C7 DTO) --------------------------------------

function toIso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
function toIsoRequired(value: string): string {
  return new Date(value).toISOString();
}

export function serializeTask(row: TaskRow): Task {
  return {
    id: row.id,
    leadId: row.leadId,
    assigneeId: row.assigneeId,
    title: row.title,
    dueAt: toIso(row.dueAt),
    completedAt: toIso(row.completedAt),
    createdBy: row.createdBy,
    createdAt: toIsoRequired(row.createdAt),
    updatedAt: toIsoRequired(row.updatedAt),
  };
}

// --- Existence checks ------------------------------------------------------

async function leadExists(db: Db, leadId: string): Promise<boolean> {
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
    .limit(1);
  return rows[0] !== undefined;
}

async function userExists(db: Db, userId: string): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] !== undefined;
}

/**
 * Recompute `leads.next_task_due_at` = min(due_at) over the lead's OPEN tasks.
 * Byte-identical to the ActivityWriter's TASK_RECOMPUTE mapping; used for the
 * non-event task mutations (due change / reopen / delete). No-op on a soft-deleted
 * lead (matches the writer's `deleted_at is null` guard).
 */
async function recomputeNextTaskDue(db: Db, leadId: string): Promise<void> {
  await db
    .update(leads)
    .set({
      nextTaskDueAt: sql`(select min(${tasks.dueAt}) from ${tasks} where ${tasks.leadId} = ${leadId} and ${tasks.completedAt} is null)`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)));
}

// --- Reads -----------------------------------------------------------------

export interface ListTasksFilter {
  leadId?: string;
  assigneeId?: string;
}

/**
 * A lead's (or assignee's) tasks as a plain array (bounded per-lead / per-assignee
 * set — the reference-data style the web uses for per-lead reads). At least one of
 * `leadId` / `assigneeId` is required by the caller. Ordered by due date (nulls
 * last, Postgres ASC default), id as tiebreak.
 */
export async function listTasks(db: Db, filter: ListTasksFilter): Promise<Task[]> {
  const conds: SQL[] = [];
  if (filter.leadId !== undefined) conds.push(eq(tasks.leadId, filter.leadId));
  if (filter.assigneeId !== undefined) conds.push(eq(tasks.assigneeId, filter.assigneeId));
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(asc(tasks.dueAt), asc(tasks.id));
  return rows.map(serializeTask);
}

export async function getTask(db: Db, id: string): Promise<Task> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new TaskNotFoundError(id);
  return serializeTask(row);
}

// --- Create ----------------------------------------------------------------

export interface CreateTaskInput {
  leadId: string;
  title: string;
  assigneeId?: string | null;
  dueAt?: string | null;
  createdBy?: string | null;
  /** Acting user recorded as the event's `user_id` (§C4). */
  actorId?: string | null;
}

export async function createTask(
  db: Db,
  input: CreateTaskInput,
  emitter?: ActivityWebhookEmitter,
): Promise<Task> {
  if (!(await leadExists(db, input.leadId))) throw new TaskLeadNotFoundError(input.leadId);
  if (input.assigneeId != null && !(await userExists(db, input.assigneeId))) {
    throw new InvalidTaskReferenceError('assigneeId', input.assigneeId);
  }
  if (input.createdBy != null && !(await userExists(db, input.createdBy))) {
    throw new InvalidTaskReferenceError('createdBy', input.createdBy);
  }

  const nowIso = new Date().toISOString();
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const inserted = await tx
      .insert(tasks)
      .values({
        leadId: input.leadId,
        title: input.title,
        assigneeId: input.assigneeId ?? null,
        dueAt: input.dueAt ?? null,
        completedAt: null,
        createdBy: input.createdBy ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new TaskError('task insert returned no row');

    await recordActivity(
      tx,
      {
        leadId: row.leadId,
        userId: input.actorId ?? input.createdBy ?? null,
        type: 'task_created',
        occurredAt: nowIso,
        payload: {
          taskId: row.id,
          title: row.title,
          ...(row.dueAt !== null ? { dueAt: toIsoRequired(row.dueAt) } : {}),
        },
      },
      emitter,
    );

    return serializeTask(row);
  });
}

// --- Patch (complete via completedAt; also title/dueAt/assignee) -------------

export interface PatchTaskInput {
  title?: string;
  dueAt?: string | null;
  assigneeId?: string | null;
  completedAt?: string | null;
  /** Acting user recorded as the completion event's `user_id` (§C4). */
  actorId?: string | null;
}

export async function patchTask(
  db: Db,
  id: string,
  input: PatchTaskInput,
  emitter?: ActivityWebhookEmitter,
): Promise<Task> {
  if (input.assigneeId != null && !(await userExists(db, input.assigneeId))) {
    throw new InvalidTaskReferenceError('assigneeId', input.assigneeId);
  }

  const nowIso = new Date().toISOString();
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const currentRows = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1)
      .for('update');
    const current = currentRows[0];
    if (current === undefined) throw new TaskNotFoundError(id);

    const set = {
      updatedAt: nowIso,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    };
    const updatedRows = await tx.update(tasks).set(set).where(eq(tasks.id, id)).returning();
    const updated = updatedRows[0];
    if (updated === undefined) throw new TaskNotFoundError(id);

    if (input.completedAt != null && current.completedAt === null) {
      // Open → completed: emit task_completed (the writer recomputes next_task_due_at).
      const completedAtIso: string = input.completedAt;
      await recordActivity(
        tx,
        {
          leadId: updated.leadId,
          userId: input.actorId ?? null,
          type: 'task_completed',
          occurredAt: completedAtIso,
          payload: { taskId: id, completedAt: completedAtIso },
        },
        emitter,
      );
    } else if (input.dueAt !== undefined || input.completedAt !== undefined) {
      // Due change or reopen (no C4 event): keep the denorm consistent ourselves.
      await recomputeNextTaskDue(tx, updated.leadId);
    }

    return serializeTask(updated);
  });
}

// --- Delete ----------------------------------------------------------------

export async function deleteTask(db: Db, id: string): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const rows = await tx
      .select({ leadId: tasks.leadId })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new TaskNotFoundError(id);
    await tx.delete(tasks).where(eq(tasks.id, id));
    // Removing an open task can change the lead's next due; recompute (no C4 event).
    await recomputeNextTaskDue(tx, row.leadId);
  });
}
