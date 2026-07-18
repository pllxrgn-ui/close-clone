import { afterEach, describe, expect, test } from 'vitest';
import { db } from '../../../mocks/fixtures.ts';
import { aiStore, callTranscript, callsForLead, noteById, resetAiStore } from './store.ts';

/*
 * The AI feature's module-scope demo store: seeded calls (with transcripts) derived
 * from the shared fixture leads, plus the AI summary notes the summarize/confirm
 * paths write. Deterministic — no Math.random at module scope (DECISIONS: seeds are
 * pure), so the demo replays identically.
 */

afterEach(() => resetAiStore());

describe('ai store seed', () => {
  test('seeds calls that reference real fixture leads and contacts', () => {
    expect(aiStore.calls.length).toBeGreaterThan(0);
    const leadIds = new Set(db.leads.map((l) => l.id));
    const contactIds = new Set(db.contacts.map((c) => c.id));
    for (const call of aiStore.calls) {
      expect(leadIds.has(call.leadId)).toBe(true);
      if (call.contactId !== null) expect(contactIds.has(call.contactId)).toBe(true);
    }
  });

  test('covers both summarizable (transcript) and not-yet-transcribed calls', () => {
    const withTranscript = aiStore.calls.filter((c) => c.transcriptRef !== null);
    const withoutTranscript = aiStore.calls.filter((c) => c.transcriptRef === null);
    expect(withTranscript.length).toBeGreaterThan(0);
    expect(withoutTranscript.length).toBeGreaterThan(0);
  });

  test('every transcript-bearing call has a canned transcript excerpt to summarize', () => {
    for (const call of aiStore.calls) {
      if (call.transcriptRef !== null) {
        expect(callTranscript(call.id).length).toBeGreaterThan(0);
      }
    }
  });

  test('callsForLead returns that lead’s calls newest-first', () => {
    const leadId = aiStore.calls[0]?.leadId;
    if (leadId === undefined) throw new Error('no seeded calls');
    const calls = callsForLead(leadId);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.leadId === leadId)).toBe(true);
    for (let i = 1; i < calls.length; i += 1) {
      const prev = calls[i - 1]?.startedAt ?? '';
      const cur = calls[i]?.startedAt ?? '';
      expect(prev >= cur).toBe(true);
    }
  });

  test('resetAiStore restores the initial deterministic state', () => {
    const before = aiStore.calls.map((c) => c.id);
    aiStore.calls.push({ ...aiStore.calls[0]!, id: 'mutant' });
    aiStore.notes.push({
      noteId: 'n',
      callId: 'x',
      leadId: 'L',
      contactId: null,
      summary: 's',
      actionItems: [],
      status: 'draft',
      confirmedBy: null,
    });
    resetAiStore();
    expect(aiStore.calls.map((c) => c.id)).toEqual(before);
    expect(aiStore.notes).toHaveLength(0);
  });

  test('noteById finds a note that was added to the store', () => {
    aiStore.notes.push({
      noteId: 'note-xyz',
      callId: 'call-1',
      leadId: 'L1',
      contactId: null,
      summary: 'a summary',
      actionItems: ['do a thing'],
      status: 'draft',
      confirmedBy: null,
    });
    expect(noteById('note-xyz')?.summary).toBe('a summary');
    expect(noteById('missing')).toBeUndefined();
  });
});
