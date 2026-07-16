import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import {
  sendIntents,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  type Db,
} from '../../db/index.ts';
import { SequenceNotFoundError, SequenceValidationError } from './errors.ts';

/**
 * Sequences CRUD (task 2e, CONTRACTS §C7 `sequences`). A sequence owns an ordered
 * list of steps; create/read/list/update here, with enroll handled by
 * `enrollment.ts`. Archiving is the only "delete" — a live sequence with
 * enrollments is never hard-removed (FKs are `on delete restrict`).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type StepType = 'email' | 'call_task' | 'sms';

export interface StepInput {
  type: StepType;
  delayHours?: number;
  templateId?: string | null;
  requiresReview?: boolean;
  condition?: Record<string, unknown> | null;
}

export interface CreateSequenceInput {
  name: string;
  status?: 'active' | 'archived';
  settings?: Record<string, unknown>;
  steps: StepInput[];
}

export type SequenceRow = typeof sequences.$inferSelect;
export type SequenceStepRow = typeof sequenceSteps.$inferSelect;

export interface SequenceWithSteps {
  sequence: SequenceRow;
  steps: SequenceStepRow[];
}

export async function createSequence(
  db: Db,
  input: CreateSequenceInput,
): Promise<SequenceWithSteps> {
  if (input.steps.length === 0) {
    throw new SequenceValidationError('a sequence must have at least one step');
  }
  for (const step of input.steps) {
    if (step.type === 'email' && (step.templateId === undefined || step.templateId === null)) {
      throw new SequenceValidationError('an email step requires a templateId');
    }
  }
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const seqRows = await tx
      .insert(sequences)
      .values({
        name: input.name,
        status: input.status ?? 'active',
        ...(input.settings !== undefined ? { settings: input.settings } : {}),
      })
      .returning();
    const sequence = seqRows[0]!;
    const steps: SequenceStepRow[] = [];
    let order = 0;
    for (const step of input.steps) {
      const rows = await tx
        .insert(sequenceSteps)
        .values({
          sequenceId: sequence.id,
          sortOrder: order,
          type: step.type,
          delayHours: step.delayHours ?? 0,
          ...(step.templateId !== undefined && step.templateId !== null
            ? { templateId: step.templateId }
            : {}),
          requiresReview: step.requiresReview ?? false,
          ...(step.condition !== undefined && step.condition !== null
            ? { condition: step.condition }
            : {}),
        })
        .returning();
      steps.push(rows[0]!);
      order += 1;
    }
    return { sequence, steps };
  });
}

export async function getSequence(db: Db, id: string): Promise<SequenceWithSteps> {
  const seqRows = await db.select().from(sequences).where(eq(sequences.id, id)).limit(1);
  const sequence = seqRows[0];
  if (sequence === undefined) throw new SequenceNotFoundError(id);
  const steps = await db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, id))
    .orderBy(asc(sequenceSteps.sortOrder), asc(sequenceSteps.id));
  return { sequence, steps };
}

export interface ListSequencesOptions {
  limit?: number;
  cursor?: string;
  status?: 'active' | 'archived';
}

export interface ListSequencesResult {
  items: SequenceRow[];
  nextCursor?: string;
}

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) throw new SequenceValidationError(`bad cursor ${raw}`);
  return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
}

export async function listSequences(
  db: Db,
  options: ListSequencesOptions = {},
): Promise<ListSequencesResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const conds = [];
  if (options.status !== undefined) conds.push(eq(sequences.status, options.status));
  if (options.cursor !== undefined) {
    const c = decodeCursor(options.cursor);
    conds.push(
      or(
        lt(sequences.createdAt, c.createdAt),
        and(eq(sequences.createdAt, c.createdAt), lt(sequences.id, c.id)),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(sequences)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(sequences.createdAt), desc(sequences.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const result: ListSequencesResult = { items };
  if (rows.length > limit) {
    const last = items[items.length - 1]!;
    result.nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.id });
  }
  return result;
}

export interface UpdateSequenceInput {
  name?: string;
  status?: 'active' | 'archived';
  settings?: Record<string, unknown>;
}

export async function updateSequence(
  db: Db,
  id: string,
  input: UpdateSequenceInput,
): Promise<SequenceRow> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.name !== undefined) set['name'] = input.name;
  if (input.status !== undefined) set['status'] = input.status;
  if (input.settings !== undefined) set['settings'] = input.settings;
  const rows = await db.update(sequences).set(set).where(eq(sequences.id, id)).returning();
  const row = rows[0];
  if (row === undefined) throw new SequenceNotFoundError(id);
  return row;
}

/** Summaries of an enrollment's intents (route read for a sequence's roster). */
export async function enrollmentsForSequence(
  db: Db,
  sequenceId: string,
): Promise<
  { id: string; leadId: string; contactId: string; state: string; pausedReason: string | null }[]
> {
  return db
    .select({
      id: sequenceEnrollments.id,
      leadId: sequenceEnrollments.leadId,
      contactId: sequenceEnrollments.contactId,
      state: sequenceEnrollments.state,
      pausedReason: sequenceEnrollments.pausedReason,
    })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.sequenceId, sequenceId))
    .orderBy(asc(sequenceEnrollments.createdAt));
}

/** Count intents by state for an enrollment (route read). */
export async function intentSummary(db: Db, enrollmentId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ state: sendIntents.state, n: sql<number>`count(*)::int` })
    .from(sendIntents)
    .where(eq(sendIntents.enrollmentId, enrollmentId))
    .groupBy(sendIntents.state);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = Number(r.n);
  return out;
}
