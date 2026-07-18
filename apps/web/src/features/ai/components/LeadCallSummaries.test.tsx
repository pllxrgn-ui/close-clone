import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { aiHandlers } from '../mocks/aiHandlers.ts';
import { aiStore, noteById, resetAiStore } from '../data/store.ts';
import { LeadCallSummaries } from './LeadCallSummaries.tsx';
import { api, makeCall, makeUser, renderAi, signInAs, signOut } from '../test/harness.tsx';

/*
 * The lead-page seam (§I-AI): Summarize a call → an AI DRAFT note shown for review →
 * the user CONFIRMS → it becomes final and lands on the timeline (carrying
 * confirmedBy). Generating writes nothing final; only the explicit confirm does.
 */

const CALL_ID = '22222222-2222-4222-8222-222222222222';
const LEAD_ID = 'lead-under-test';

/** Inject a known transcript-bearing call for LEAD_ID into the store + /calls. */
function seedOneCall(): void {
  const call = makeCall({
    id: CALL_ID,
    leadId: LEAD_ID,
    contactId: null,
    transcriptRef: 'txn://x',
  });
  aiStore.calls.push(call);
  aiStore.transcripts.set(CALL_ID, 'They asked us to send a revised quote next week.');
  server.use(http.get(api('/calls'), () => HttpResponse.json([call])));
}

function timelineCount(leadId: string, type: string): number {
  return (db.activitiesByLead.get(leadId) ?? []).filter((a) => a.type === type).length;
}

beforeEach(() => {
  resetAiStore();
  signInAs(makeUser());
  server.use(...aiHandlers);
});
afterEach(() => {
  signOut();
  db.activitiesByLead.delete(LEAD_ID);
  cleanup();
});

describe('LeadCallSummaries', () => {
  test('summarize → draft (no timeline write) → confirm → final + note_added', async () => {
    const user = userEvent.setup();
    seedOneCall();
    renderAi(<LeadCallSummaries leadId={LEAD_ID} />);

    const summarize = await screen.findByRole('button', { name: /summarize/i });
    expect(timelineCount(LEAD_ID, 'note_added')).toBe(0);

    await user.click(summarize);

    // A DRAFT is shown for review — nothing final, no timeline event yet (§I-AI).
    const draftBadge = await screen.findByText(/ai draft/i);
    expect(draftBadge).toBeInTheDocument();
    expect(screen.getByText(/current evaluation status/i)).toBeInTheDocument();
    expect(timelineCount(LEAD_ID, 'note_added')).toBe(0);
    // The store note is a draft authored by no user.
    const draftNote = aiStore.notes.find((n) => n.callId === CALL_ID);
    expect(draftNote?.status).toBe('draft');
    expect(draftNote?.confirmedBy).toBeNull();

    // Confirm is the explicit, recorded human action.
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    await screen.findByText(/added to the timeline/i);
    await waitFor(() => expect(timelineCount(LEAD_ID, 'note_added')).toBe(1));
    const noteId = draftNote?.noteId ?? '';
    expect(noteById(noteId)?.status).toBe('final');
    const landed = (db.activitiesByLead.get(LEAD_ID) ?? []).find((a) => a.type === 'note_added');
    expect(landed?.userId).toBe(makeUser().id);
    expect((landed?.payload as { confirmedBy?: string }).confirmedBy).toBe(makeUser().id);
  });

  test('confirm is disabled without a signed-in user (no confirmedBy, §I-AI)', async () => {
    const user = userEvent.setup();
    signOut(); // no current user → nobody to record as the confirmer
    seedOneCall();
    renderAi(<LeadCallSummaries leadId={LEAD_ID} />);

    await user.click(await screen.findByRole('button', { name: /summarize/i }));
    const confirm = await screen.findByRole('button', { name: /confirm/i });
    expect(confirm).toBeDisabled();
    // Generating still produced only a draft — never a final row.
    expect(timelineCount(LEAD_ID, 'note_added')).toBe(0);
  });

  test('discard removes the draft and re-enables Summarize (nothing final)', async () => {
    const user = userEvent.setup();
    seedOneCall();
    renderAi(<LeadCallSummaries leadId={LEAD_ID} />);

    await user.click(await screen.findByRole('button', { name: /summarize/i }));
    await screen.findByText(/ai draft/i);
    await user.click(screen.getByRole('button', { name: /discard/i }));

    expect(screen.queryByText(/ai draft/i)).toBeNull();
    expect(await screen.findByRole('button', { name: /summarize/i })).toBeEnabled();
    expect(timelineCount(LEAD_ID, 'note_added')).toBe(0);
  });

  test('a call with no transcript cannot be summarized (disabled + hint)', async () => {
    seedOneCall();
    const noTranscript = makeCall({
      id: '33333333-3333-4333-8333-333333333333',
      leadId: LEAD_ID,
      transcriptRef: null,
    });
    server.use(http.get(api('/calls'), () => HttpResponse.json([noTranscript])));
    renderAi(<LeadCallSummaries leadId={LEAD_ID} />);

    const row = (await screen.findByRole('button', { name: /summarize/i })).closest('li');
    if (!row) throw new Error('no call row');
    expect(within(row).getByRole('button', { name: /summarize/i })).toBeDisabled();
    expect(within(row).getByText(/no transcript/i)).toBeInTheDocument();
  });

  test('empty state when the lead has no calls', async () => {
    server.use(http.get(api('/calls'), () => HttpResponse.json([])));
    renderAi(<LeadCallSummaries leadId={LEAD_ID} />);
    expect(await screen.findByText(/no recorded calls/i)).toBeInTheDocument();
  });

  test('error state with retry when the calls request fails', async () => {
    server.use(
      http.get(api('/calls'), () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderAi(<LeadCallSummaries leadId={LEAD_ID} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });
});
