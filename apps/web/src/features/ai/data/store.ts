/*
 * The AI feature's in-memory demo store — module-scope state seeded deterministically
 * from the shared fixture `db` (imported read-only). Two things live here:
 *
 *  1. Seeded CALLS (C1 `Call` DTOs) with transcripts, so the call-summary seam has a
 *     real callId to act on. C7 has no GET calls-by-lead route (see api/ai.ts), so the
 *     demo seeds and serves them; the summarize/confirm routes it calls ARE real C7.
 *  2. The AI summary NOTES the summarize→confirm flow writes. `generate` adds a DRAFT
 *     note here (no timeline event); `confirm` flips it to final and appends the
 *     `note_added` activity to the shared timeline `db` — the §I-AI split, structural.
 *
 * Deterministic: a fixed seed drives a mulberry32 PRNG (no Math.random at module
 * scope), so the demo replays identically and survives route changes (resets on
 * reload). Shapes are the @switchboard/shared C1 DTOs so the same UI works on the
 * real API later.
 */
import type { Call } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import { chance, int, mulberry32, pick, uuidFrom } from '../../../mocks/seed.ts';

/** An AI-generated call-summary note as tracked by the demo (draft → final). */
export interface AiSummaryNote {
  noteId: string;
  callId: string;
  leadId: string;
  contactId: string | null;
  summary: string;
  actionItems: string[];
  status: 'draft' | 'final';
  /** The confirming user (§I-AI) — null until an explicit human confirm. */
  confirmedBy: string | null;
}

export interface AiState {
  calls: Call[];
  /** callId → canned transcript excerpt driving the deterministic summary. */
  transcripts: Map<string, string>;
  notes: AiSummaryNote[];
}

const SEED = 0xa11ce5;
const NOW = new Date('2026-07-15T17:00:00.000Z');
const iso = (offsetMinutes: number): string =>
  new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

/** Realistic sales-call excerpts; some carry the action-item trigger words. */
const TRANSCRIPTS: readonly string[] = [
  'They walked through the current stack and asked us to send a revised quote by Friday. Budget is approved for Q3.',
  'Champion is happy with the demo but needs internal sign-off. Wants to reconnect next week after looping in their VP.',
  'Raised concerns about migration effort. Agreed a follow-up call to scope the data import together.',
  'Renewal conversation — usage is up 40%. Asked for a summary of the new plan tiers to share with finance.',
  'Cold outreach connect. Not a fit this quarter, but asked us to follow up in the fall when headcount grows.',
  'Technical deep-dive on the compliance rails. Legal wants the DNC + consent handling documented before signing.',
  'Pricing pushback on the enterprise tier. Discussed a phased rollout; sending a revised quote with the pilot scope.',
];

const OUTCOMES: readonly Call['outcome'][] = [
  'connected',
  'voicemail',
  'connected',
  'no-answer',
  'connected',
];

function firstContactByLead(): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of db.contacts) {
    if (c.deletedAt === null && !map.has(c.leadId)) map.set(c.leadId, c.id);
  }
  return map;
}

function buildInitialState(): AiState {
  const rng = mulberry32(SEED);
  const contactByLead = firstContactByLead();
  const calls: Call[] = [];
  const transcripts = new Map<string, string>();
  let minuteCursor = -30;

  for (const lead of db.leads) {
    const contactId = contactByLead.get(lead.id) ?? null;
    const owner = lead.ownerId;
    // 1 call for every lead; ~1 in 3 leads gets a second, older call.
    const callCount = chance(rng, 0.34) ? 2 : 1;
    for (let n = 0; n < callCount; n += 1) {
      const id = uuidFrom(rng);
      // ~70% of calls have a transcript (summarizable); the rest are not-yet
      // transcribed (the disabled/"can't summarize yet" state — full coverage).
      const hasTranscript = chance(rng, 0.7);
      const excerpt = pick(rng, TRANSCRIPTS);
      minuteCursor -= int(rng, 60, 6000);
      const startedAt = iso(minuteCursor);
      const durationS = int(rng, 90, 1500);
      const call: Call = {
        id,
        leadId: lead.id,
        contactId,
        userId: owner,
        direction: chance(rng, 0.6) ? 'outbound' : 'inbound',
        twilioSid: null,
        status: 'completed',
        durationS,
        outcome: pick(rng, OUTCOMES),
        recordingRef: `rec://${id}`,
        transcriptRef: hasTranscript ? `txn://${id}` : null,
        startedAt,
        endedAt: iso(minuteCursor + Math.round(durationS / 60)),
        createdAt: startedAt,
        updatedAt: startedAt,
      };
      calls.push(call);
      if (hasTranscript) transcripts.set(id, excerpt);
    }
  }

  return { calls, transcripts, notes: [] };
}

/** The live, mutable store. Handlers read and write this object's fields. */
export const aiStore: AiState = buildInitialState();

/** Re-seed to the initial deterministic state (used by tests for isolation). */
export function resetAiStore(): void {
  Object.assign(aiStore, buildInitialState());
}

/** A lead's calls, newest-first (by startedAt). */
export function callsForLead(leadId: string): Call[] {
  return aiStore.calls
    .filter((c) => c.leadId === leadId)
    .sort((a, b) => ((a.startedAt ?? '') < (b.startedAt ?? '') ? 1 : -1));
}

/** The canned transcript excerpt for a call (empty string if not transcribed). */
export function callTranscript(callId: string): string {
  return aiStore.transcripts.get(callId) ?? '';
}

/** Find one call by id. */
export function callById(callId: string): Call | undefined {
  return aiStore.calls.find((c) => c.id === callId);
}

/** Find one AI summary note by id. */
export function noteById(noteId: string): AiSummaryNote | undefined {
  return aiStore.notes.find((n) => n.noteId === noteId);
}
