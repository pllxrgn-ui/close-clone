import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { calls, notes, type Db } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { createMockASRProvider, type MockASRProvider } from '../../providers/asr/index.ts';
import { createMockAIProvider, type MockAIProvider } from '../../providers/ai/index.ts';
import { seedContact, seedLead, seedUser, activitiesFor } from '../telephony/test-helpers.ts';
import {
  CallNotFoundError,
  NoTranscriptSourceError,
  NotAiNoteError,
  SummaryAlreadyFinalError,
  SummaryNoteNotFoundError,
  confirmCallSummary,
  generateCallSummaryDraft,
} from './call-summary.ts';

/**
 * AI call summaries (task 3e) — §I-AI is the through-line. The suite pins the
 * never-event: generate writes a DRAFT note and NO timeline event; only an explicit
 * confirm (carrying confirmedBy) flips it to final + emits `note_added`.
 */

const NIL = '00000000-0000-4000-8000-0000000000ff';

let ctx: TestDb;
let db: Db;
let asr: MockASRProvider;
let ai: MockAIProvider;
let rep: string;
let lead: string;
let contact: string;

async function seedCall(opts: { recordingRef?: string | null } = {}): Promise<string> {
  const rows = await db
    .insert(calls)
    .values({
      leadId: lead,
      contactId: contact,
      userId: rep,
      direction: 'outbound',
      status: 'completed',
      recordingRef: opts.recordingRef === undefined ? 'rec-abc' : opts.recordingRef,
    })
    .returning({ id: calls.id });
  return rows[0]!.id;
}

async function noteRow(
  noteId: string,
): Promise<{ status: string; aiGenerated: boolean; authorId: string | null }> {
  const rows = await db
    .select({ status: notes.status, aiGenerated: notes.aiGenerated, authorId: notes.authorId })
    .from(notes)
    .where(eq(notes.id, noteId))
    .limit(1);
  return rows[0]!;
}

beforeEach(async () => {
  ctx = await createTestDb();
  db = ctx.db;
  asr = createMockASRProvider();
  ai = createMockAIProvider();
  rep = await seedUser(db, { name: 'Rep' });
  lead = await seedLead(db, { name: 'Acme', ownerId: rep });
  contact = await seedContact(db, lead, ['+13055550147'], { name: 'Jane' });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('generateCallSummaryDraft', () => {
  test('writes a DRAFT note (ai_generated, no author) and NO timeline event', async () => {
    const callId = await seedCall();
    const draft = await generateCallSummaryDraft({ db, asr, ai }, { callId });

    expect(draft.status).toBe('draft');
    expect(draft.aiGenerated).toBe(true);
    expect(draft.summary.length).toBeGreaterThan(0);

    const note = await noteRow(draft.noteId);
    expect(note.status).toBe('draft');
    expect(note.aiGenerated).toBe(true);
    expect(note.authorId).toBeNull(); // the AI is not a user

    // §I-AI: no note_added timeline event exists before the confirm.
    const acts = await activitiesFor(db, lead);
    expect(acts.filter((a) => a.type === 'note_added')).toHaveLength(0);
  });

  test('transcribes from the call recording ref via the ASR provider', async () => {
    const callId = await seedCall({ recordingRef: 'rec-xyz' });
    ai.scriptSummary(
      // The mock ASR derives a transcript containing the ref; script the summary off it.
      (await asr.transcribe('rec-xyz')).text,
      { summary: 'scripted summary', actionItems: ['follow up'] },
    );
    const draft = await generateCallSummaryDraft({ db, asr, ai }, { callId });
    expect(draft.summary).toBe('scripted summary');
  });

  test('unknown call → CallNotFoundError', async () => {
    await expect(generateCallSummaryDraft({ db, asr, ai }, { callId: NIL })).rejects.toBeInstanceOf(
      CallNotFoundError,
    );
  });

  test('call with no recording/transcript → NoTranscriptSourceError', async () => {
    const callId = await seedCall({ recordingRef: null });
    await expect(generateCallSummaryDraft({ db, asr, ai }, { callId })).rejects.toBeInstanceOf(
      NoTranscriptSourceError,
    );
  });
});

describe('confirmCallSummary', () => {
  test('flips draft → final, stamps confirmedBy as author, emits ONE note_added', async () => {
    const callId = await seedCall();
    const draft = await generateCallSummaryDraft({ db, asr, ai }, { callId });

    const result = await confirmCallSummary({ db }, { noteId: draft.noteId, confirmedBy: rep });
    expect(result.status).toBe('final');
    expect(result.confirmedBy).toBe(rep);

    const note = await noteRow(draft.noteId);
    expect(note.status).toBe('final');
    expect(note.authorId).toBe(rep); // recorded user action (§I-AI)

    const noteAdded = (await activitiesFor(db, lead)).filter((a) => a.type === 'note_added');
    expect(noteAdded).toHaveLength(1);
    expect(noteAdded[0]?.payload).toMatchObject({
      noteId: draft.noteId,
      aiGenerated: true,
      confirmedBy: rep,
    });
  });

  test('confirming twice is refused (idempotency guard) and emits no second event', async () => {
    const callId = await seedCall();
    const draft = await generateCallSummaryDraft({ db, asr, ai }, { callId });
    await confirmCallSummary({ db }, { noteId: draft.noteId, confirmedBy: rep });

    await expect(
      confirmCallSummary({ db }, { noteId: draft.noteId, confirmedBy: rep }),
    ).rejects.toBeInstanceOf(SummaryAlreadyFinalError);

    const noteAdded = (await activitiesFor(db, lead)).filter((a) => a.type === 'note_added');
    expect(noteAdded).toHaveLength(1); // still exactly one
  });

  test('unknown note → SummaryNoteNotFoundError', async () => {
    await expect(
      confirmCallSummary({ db }, { noteId: NIL, confirmedBy: rep }),
    ).rejects.toBeInstanceOf(SummaryNoteNotFoundError);
  });

  test('a human (non-AI) note cannot be confirmed via this path', async () => {
    const inserted = await db
      .insert(notes)
      .values({
        leadId: lead,
        authorId: rep,
        bodyMd: 'human note',
        status: 'draft',
        aiGenerated: false,
      })
      .returning({ id: notes.id });
    await expect(
      confirmCallSummary({ db }, { noteId: inserted[0]!.id, confirmedBy: rep }),
    ).rejects.toBeInstanceOf(NotAiNoteError);
  });

  test('blank confirmedBy is refused (defence in depth)', async () => {
    const callId = await seedCall();
    const draft = await generateCallSummaryDraft({ db, asr, ai }, { callId });
    await expect(
      confirmCallSummary({ db }, { noteId: draft.noteId, confirmedBy: '' }),
    ).rejects.toThrow(/confirmedBy/);
    // Still a draft, still no timeline event.
    expect((await noteRow(draft.noteId)).status).toBe('draft');
    expect((await activitiesFor(db, lead)).filter((a) => a.type === 'note_added')).toHaveLength(0);
  });
});
