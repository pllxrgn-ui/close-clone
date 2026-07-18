import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Note } from '@switchboard/shared';
import { leads, notes, users, type Db } from '../../db/index.ts';
import { recordActivity, type ActivityWebhookEmitter } from '../activity/index.ts';

/**
 * Notes CRUD service (CONTRACTS §C7 `notes`, §C1 schema, §C4 `note_added`). The
 * real-API realization of the (human) notes surface. See CONTRACTS §C7 v1.3.1.
 *
 * §I-AI is structural here, mirroring `services/ai/call-summary.ts`:
 *   - AI-generated notes are BORN as drafts by the AI call-summary route
 *     (`ai_generated=true, status='draft', author_id=NULL`) and reach `final`
 *     ONLY through `POST /ai/call-summaries/:id/confirm` (which records the
 *     confirming user and emits `note_added`). This service NEVER creates an AI
 *     note (POST is human-only) and NEVER flips an AI draft to `final`
 *     ({@link patchNote} refuses it). So there is no bypass of the confirm step.
 *   - A HUMAN note reaching `final` (POST final, or PATCH draft→final) is itself
 *     the recorded user action, so it emits `note_added` directly.
 *
 * `note_added` fires exactly when a note becomes `final` (never for a draft),
 * mirroring the AI split (draft create emits nothing; confirm emits the event).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

type NoteRow = typeof notes.$inferSelect;
type NoteStatus = Note['status'];

// --- Errors ----------------------------------------------------------------

export class NoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteError';
  }
}

/** The note id does not exist. Maps to NOT_FOUND (§C8). */
export class NoteNotFoundError extends NoteError {
  readonly noteId: string;
  constructor(noteId: string) {
    super(`note ${noteId} not found`);
    this.name = 'NoteNotFoundError';
    this.noteId = noteId;
  }
}

/** The target lead is missing or soft-deleted. Maps to NOT_FOUND (§C8). */
export class NoteLeadNotFoundError extends NoteError {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`lead ${leadId} not found or soft-deleted`);
    this.name = 'NoteLeadNotFoundError';
    this.leadId = leadId;
  }
}

/** A referenced FK (authorId) does not exist. Maps to VALIDATION_FAILED (§C8). */
export class InvalidNoteReferenceError extends NoteError {
  readonly field: string;
  readonly value: string;
  constructor(field: string, value: string) {
    super(`invalid ${field}: ${value} does not exist`);
    this.name = 'InvalidNoteReferenceError';
    this.field = field;
    this.value = value;
  }
}

/**
 * §I-AI guard: an AI-generated note cannot be finalized through the generic notes
 * PATCH — only the AI confirm route may (it records the confirming user). Maps to
 * VALIDATION_FAILED (§C8), mirroring the ai route's I-AI rejections.
 */
export class AiNoteFinalizeError extends NoteError {
  readonly noteId: string;
  constructor(noteId: string) {
    super(
      `note ${noteId} is AI-generated; finalize it via the AI confirm route ` +
        `(POST /api/v1/ai/call-summaries/:noteId/confirm), not this endpoint`,
    );
    this.name = 'AiNoteFinalizeError';
    this.noteId = noteId;
  }
}

// --- Serialization (DB row → §C7 DTO) --------------------------------------

function toIsoRequired(value: string): string {
  return new Date(value).toISOString();
}

export function serializeNote(row: NoteRow): Note {
  return {
    id: row.id,
    leadId: row.leadId,
    authorId: row.authorId,
    bodyMd: row.bodyMd,
    status: row.status,
    aiGenerated: row.aiGenerated,
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

// --- Reads -----------------------------------------------------------------

/** A lead's notes as a plain array (newest first), per-lead bounded set. */
export async function listNotesByLead(db: Db, leadId: string): Promise<Note[]> {
  const rows = await db
    .select()
    .from(notes)
    .where(eq(notes.leadId, leadId))
    .orderBy(desc(notes.createdAt), desc(notes.id));
  return rows.map(serializeNote);
}

export async function getNote(db: Db, id: string): Promise<Note> {
  const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new NoteNotFoundError(id);
  return serializeNote(row);
}

// --- Create (human notes only; §I-AI) --------------------------------------

export interface CreateNoteInput {
  leadId: string;
  bodyMd: string;
  /** 'draft' (no event) or 'final' (emits note_added). Defaults to 'final'. */
  status?: NoteStatus;
  authorId?: string | null;
  /** Acting user recorded as the note_added event's `user_id` (§C4). */
  actorId?: string | null;
}

export async function createNote(
  db: Db,
  input: CreateNoteInput,
  emitter?: ActivityWebhookEmitter,
): Promise<Note> {
  if (!(await leadExists(db, input.leadId))) throw new NoteLeadNotFoundError(input.leadId);
  if (input.authorId != null && !(await userExists(db, input.authorId))) {
    throw new InvalidNoteReferenceError('authorId', input.authorId);
  }
  const status: NoteStatus = input.status ?? 'final';
  const nowIso = new Date().toISOString();

  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const inserted = await tx
      .insert(notes)
      .values({
        leadId: input.leadId,
        authorId: input.authorId ?? null,
        bodyMd: input.bodyMd,
        status,
        // §I-AI: this service only ever writes human notes. AI notes are created
        // by services/ai (draft) and finalized by its confirm route.
        aiGenerated: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new NoteError('note insert returned no row');

    if (status === 'final') {
      await recordActivity(
        tx,
        {
          leadId: row.leadId,
          userId: input.actorId ?? input.authorId ?? null,
          type: 'note_added',
          occurredAt: nowIso,
          payload: { noteId: row.id, aiGenerated: false },
        },
        emitter,
      );
    }

    return serializeNote(row);
  });
}

// --- Patch (body / status draft|final) -------------------------------------

export interface PatchNoteInput {
  bodyMd?: string;
  status?: NoteStatus;
  /** Acting user recorded as the note_added event's `user_id` (§C4). */
  actorId?: string | null;
}

export async function patchNote(
  db: Db,
  id: string,
  input: PatchNoteInput,
  emitter?: ActivityWebhookEmitter,
): Promise<Note> {
  const nowIso = new Date().toISOString();
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const currentRows = await tx
      .select()
      .from(notes)
      .where(eq(notes.id, id))
      .limit(1)
      .for('update');
    const current = currentRows[0];
    if (current === undefined) throw new NoteNotFoundError(id);

    const finalizing = input.status === 'final' && current.status !== 'final';
    // §I-AI: refuse to finalize an AI-generated note here — it must go through the
    // AI confirm route, which records the confirming user. Refuse BEFORE any write.
    if (finalizing && current.aiGenerated) throw new AiNoteFinalizeError(id);

    const set = {
      updatedAt: nowIso,
      ...(input.bodyMd !== undefined ? { bodyMd: input.bodyMd } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };
    const updatedRows = await tx.update(notes).set(set).where(eq(notes.id, id)).returning();
    const updated = updatedRows[0];
    if (updated === undefined) throw new NoteNotFoundError(id);

    if (finalizing) {
      // Human draft → final: the finalize IS the recorded user action (§I-AI).
      await recordActivity(
        tx,
        {
          leadId: updated.leadId,
          userId: input.actorId ?? updated.authorId ?? null,
          type: 'note_added',
          occurredAt: nowIso,
          payload: { noteId: id, aiGenerated: false },
        },
        emitter,
      );
    }

    return serializeNote(updated);
  });
}

// --- Delete ----------------------------------------------------------------

export async function deleteNote(db: Db, id: string): Promise<void> {
  const deleted = await db.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id });
  if (deleted.length === 0) throw new NoteNotFoundError(id);
}
