import { and, eq, isNull } from 'drizzle-orm';
import {
  callSummaryContextSchema,
  type AIProvider,
  type ASRProvider,
  type CallSummaryContext,
} from '@switchboard/shared/providers';
import { calls, contacts, leads, notes, type Db } from '../../db/index.ts';
import { recordActivity } from '../activity/index.ts';

/**
 * AI call summaries (task 3e) — the §I-AI through-line.
 *
 * ARCHITECTURE §7 / CONTRACTS §I-AI: "no AI output row reaches status='final' or
 * sends without an explicit user action recorded (the confirming request carries
 * confirmedBy)." This module splits the two halves so the invariant is structural:
 *
 *   1. {@link generateCallSummaryDraft} runs ASR → AI and writes the result as a
 *      DRAFT note ONLY (`status='draft'`, `ai_generated=true`, `author_id=NULL` —
 *      the AI is not a user). It writes NO timeline event. There is no code path in
 *      this function that produces a `final` note or a `note_added` activity.
 *   2. {@link confirmCallSummary} is the SOLE transition to `final`: it flips the
 *      draft to `final`, stamps `author_id = confirmedBy` (the confirming user
 *      becomes the note's author of record), and emits the `note_added` timeline
 *      event through the ActivityWriter — all in one transaction, carrying
 *      `confirmedBy`. A missing/blank `confirmedBy` never reaches here (the route
 *      requires a uuid), so an AI note can only become final via an explicit human
 *      action that is recorded.
 *
 * The property/unit suite asserts (1) never yields a final note or a timeline event,
 * and that only (2) does.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

// --- Errors ----------------------------------------------------------------

export class CallSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallSummaryError';
  }
}

/** The referenced call row is missing. */
export class CallNotFoundError extends CallSummaryError {
  readonly callId: string;
  constructor(callId: string) {
    super(`call ${callId} not found`);
    this.name = 'CallNotFoundError';
    this.callId = callId;
  }
}

/** No transcript/recording handle to transcribe (nothing to summarize). */
export class NoTranscriptSourceError extends CallSummaryError {
  readonly callId: string;
  constructor(callId: string) {
    super(`call ${callId} has no recording or transcript to summarize`);
    this.name = 'NoTranscriptSourceError';
    this.callId = callId;
  }
}

/** The note to confirm does not exist. */
export class SummaryNoteNotFoundError extends CallSummaryError {
  readonly noteId: string;
  constructor(noteId: string) {
    super(`ai summary note ${noteId} not found`);
    this.name = 'SummaryNoteNotFoundError';
    this.noteId = noteId;
  }
}

/** The note is not an AI-generated note (confirm is only for AI drafts). */
export class NotAiNoteError extends CallSummaryError {
  readonly noteId: string;
  constructor(noteId: string) {
    super(`note ${noteId} is not an AI-generated note`);
    this.name = 'NotAiNoteError';
    this.noteId = noteId;
  }
}

/** The note is already final — confirming twice is refused (idempotency guard). */
export class SummaryAlreadyFinalError extends CallSummaryError {
  readonly noteId: string;
  constructor(noteId: string) {
    super(`ai summary note ${noteId} is already final`);
    this.name = 'SummaryAlreadyFinalError';
    this.noteId = noteId;
  }
}

// --- Generate (draft only) -------------------------------------------------

export interface GenerateCallSummaryDeps {
  db: Db;
  asr: ASRProvider;
  ai: AIProvider;
  now?: () => Date;
}

export interface GenerateCallSummaryInput {
  callId: string;
  /** Override the audio handle; defaults to the call's transcript/recording ref. */
  audioRef?: string;
}

export interface CallSummaryDraft {
  noteId: string;
  leadId: string;
  contactId: string | null;
  summary: string;
  actionItems: string[];
  status: 'draft';
  aiGenerated: true;
}

export async function generateCallSummaryDraft(
  deps: GenerateCallSummaryDeps,
  input: GenerateCallSummaryInput,
): Promise<CallSummaryDraft> {
  const now = deps.now ?? ((): Date => new Date());
  const callRows = await deps.db
    .select({
      id: calls.id,
      leadId: calls.leadId,
      contactId: calls.contactId,
      direction: calls.direction,
      recordingRef: calls.recordingRef,
      transcriptRef: calls.transcriptRef,
    })
    .from(calls)
    .where(eq(calls.id, input.callId))
    .limit(1);
  const call = callRows[0];
  if (call === undefined) throw new CallNotFoundError(input.callId);

  const audioRef = input.audioRef ?? call.transcriptRef ?? call.recordingRef;
  if (audioRef === null || audioRef === undefined || audioRef.length === 0) {
    throw new NoTranscriptSourceError(input.callId);
  }

  const context = await buildContext(deps.db, call.leadId, call.contactId, call.direction);
  const transcript = await deps.asr.transcribe(audioRef);
  const result = await deps.ai.summarizeCall(transcript, context);

  const bodyMd = renderDraftBody(result.summary, result.actionItems);
  const nowIso = now().toISOString();

  const inserted = await deps.db
    .insert(notes)
    .values({
      leadId: call.leadId,
      // The AI is not a user: draft author is null until a human confirms (§I-AI).
      authorId: null,
      bodyMd,
      status: 'draft',
      aiGenerated: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .returning({ id: notes.id });
  const noteId = inserted[0]?.id;
  if (noteId === undefined) throw new CallSummaryError('note insert returned no row');

  return {
    noteId,
    leadId: call.leadId,
    contactId: call.contactId,
    summary: result.summary,
    actionItems: result.actionItems,
    status: 'draft',
    aiGenerated: true,
  };
}

// --- Confirm (draft → final + timeline event) ------------------------------

export interface ConfirmCallSummaryDeps {
  db: Db;
  now?: () => Date;
}

export interface ConfirmCallSummaryInput {
  noteId: string;
  /** The user confirming the AI draft (§I-AI: the recorded user action). */
  confirmedBy: string;
}

export interface ConfirmCallSummaryResult {
  noteId: string;
  status: 'final';
  activityId: string;
  confirmedBy: string;
}

export async function confirmCallSummary(
  deps: ConfirmCallSummaryDeps,
  input: ConfirmCallSummaryInput,
): Promise<ConfirmCallSummaryResult> {
  const now = deps.now ?? ((): Date => new Date());
  if (input.confirmedBy.length === 0) {
    // Defence in depth: the route requires a uuid, but never allow a blank confirmer.
    throw new CallSummaryError('confirmCallSummary requires a confirmedBy user');
  }

  return deps.db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const rows = await tx
      .select({
        id: notes.id,
        leadId: notes.leadId,
        status: notes.status,
        aiGenerated: notes.aiGenerated,
      })
      .from(notes)
      .where(eq(notes.id, input.noteId))
      .limit(1)
      .for('update');
    const note = rows[0];
    if (note === undefined) throw new SummaryNoteNotFoundError(input.noteId);
    if (!note.aiGenerated) throw new NotAiNoteError(input.noteId);
    if (note.status === 'final') throw new SummaryAlreadyFinalError(input.noteId);

    const nowIso = now().toISOString();
    // Stamp the confirming user as author of record, and flip to final.
    await tx
      .update(notes)
      .set({ status: 'final', authorId: input.confirmedBy, updatedAt: nowIso })
      .where(eq(notes.id, input.noteId));

    // Emit the timeline event ONLY now, carrying confirmedBy (§I-AI). recordActivity
    // opens a savepoint on this tx, so the flip + the event commit atomically.
    const activity = await recordActivity(tx, {
      leadId: note.leadId,
      userId: input.confirmedBy,
      type: 'note_added',
      occurredAt: nowIso,
      payload: { noteId: input.noteId, aiGenerated: true, confirmedBy: input.confirmedBy },
    });

    return {
      noteId: input.noteId,
      status: 'final',
      activityId: activity.id,
      confirmedBy: input.confirmedBy,
    };
  });
}

// --- internals -------------------------------------------------------------

async function buildContext(
  db: Db,
  leadId: string,
  contactId: string | null,
  direction: 'inbound' | 'outbound',
): Promise<CallSummaryContext> {
  const leadRows = await db
    .select({ name: leads.name })
    .from(leads)
    .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
    .limit(1);
  let contactName: string | undefined;
  if (contactId !== null) {
    const contactRows = await db
      .select({ name: contacts.name })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    contactName = contactRows[0]?.name;
  }
  return callSummaryContextSchema.parse({
    ...(leadRows[0]?.name !== undefined ? { leadName: leadRows[0].name } : {}),
    ...(contactName !== undefined ? { contactName } : {}),
    direction,
  });
}

function renderDraftBody(summary: string, actionItems: string[]): string {
  const items =
    actionItems.length > 0
      ? '\n\n**Action items:**\n' + actionItems.map((a) => `- [ ] ${a}`).join('\n')
      : '';
  return `**Call summary (AI-generated draft)**\n\n${summary}${items}`;
}
