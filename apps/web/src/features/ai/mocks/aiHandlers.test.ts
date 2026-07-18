import { beforeEach, describe, expect, test } from 'vitest';
import type { Call } from '@switchboard/shared';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { aiHandlers } from './aiHandlers.ts';
import { aiStore, noteById, resetAiStore } from '../data/store.ts';

/*
 * Handler-level contract tests for the AI MSW surface. These pin the §I-AI
 * invariants the component tests exercise only indirectly:
 *  - `generate` writes a DRAFT note and NO timeline event (nothing final);
 *  - `confirm` is the SOLE draft→final transition, requires `confirmedBy`, and lands
 *    exactly one `note_added` carrying that confirmer;
 *  - NL→Smart View re-parses AI DSL and 400s (with rawDsl+position) on invalid text.
 * Assertions on the shared `db.activitiesByLead` use before/after deltas since that
 * fixture map is not reset between tests.
 */

const CONFIRMER = '11111111-1111-4111-8111-111111111111';

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function timelineCount(leadId: string, type?: string): number {
  const list = db.activitiesByLead.get(leadId) ?? [];
  return type ? list.filter((a) => a.type === type).length : list.length;
}

function errorCode(json: unknown): string | undefined {
  const err = (json as { error?: { code?: unknown } } | null)?.error;
  return err && typeof err.code === 'string' ? err.code : undefined;
}

function withTranscript(): Call {
  const call = aiStore.calls.find((c) => c.transcriptRef !== null);
  if (!call) throw new Error('no transcript-bearing call seeded');
  return call;
}
function withoutTranscript(): Call {
  const call = aiStore.calls.find((c) => c.transcriptRef === null);
  if (!call) throw new Error('no not-yet-transcribed call seeded');
  return call;
}

beforeEach(() => {
  resetAiStore();
  server.use(...aiHandlers);
});

describe('GET /calls', () => {
  test('lists a lead’s seeded calls; requires leadId', async () => {
    const call = withTranscript();
    const ok = await req('GET', `/calls?leadId=${call.leadId}`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.json)).toBe(true);
    expect((ok.json as Call[]).every((c) => c.leadId === call.leadId)).toBe(true);

    const bad = await req('GET', '/calls');
    expect(bad.status).toBe(400);
    expect(errorCode(bad.json)).toBe('VALIDATION_FAILED');
  });
});

describe('POST /ai/call-summaries (generate — draft only)', () => {
  test('returns a DRAFT note and writes NO timeline event (§I-AI)', async () => {
    const call = withTranscript();
    const before = timelineCount(call.leadId, 'note_added');

    const res = await req('POST', '/ai/call-summaries', { callId: call.id });

    expect(res.status).toBe(200);
    const draft = res.json as {
      noteId: string;
      status: string;
      aiGenerated: boolean;
      summary: string;
      actionItems: string[];
    };
    expect(draft.status).toBe('draft');
    expect(draft.aiGenerated).toBe(true);
    expect(draft.summary.length).toBeGreaterThan(0);
    // The note exists in the store as a draft, authored by no user yet.
    expect(noteById(draft.noteId)?.status).toBe('draft');
    expect(noteById(draft.noteId)?.confirmedBy).toBeNull();
    // Nothing final: the timeline did NOT gain a note_added.
    expect(timelineCount(call.leadId, 'note_added')).toBe(before);
  });

  test('400 when the call has no transcript to summarize', async () => {
    const call = withoutTranscript();
    const res = await req('POST', '/ai/call-summaries', { callId: call.id });
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe('VALIDATION_FAILED');
  });

  test('404 when the call does not exist', async () => {
    const res = await req('POST', '/ai/call-summaries', {
      callId: '99999999-9999-4999-8999-999999999999',
    });
    expect(res.status).toBe(404);
    expect(errorCode(res.json)).toBe('NOT_FOUND');
  });
});

describe('POST /ai/call-summaries/:id/confirm (the SOLE draft→final)', () => {
  async function makeDraft(): Promise<{ noteId: string; leadId: string }> {
    const call = withTranscript();
    const res = await req('POST', '/ai/call-summaries', { callId: call.id });
    return { noteId: (res.json as { noteId: string }).noteId, leadId: call.leadId };
  }

  test('confirm flips draft→final and lands exactly one note_added carrying confirmedBy', async () => {
    const { noteId, leadId } = await makeDraft();
    const before = timelineCount(leadId, 'note_added');

    const res = await req('POST', `/ai/call-summaries/${noteId}/confirm`, {
      confirmedBy: CONFIRMER,
    });

    expect(res.status).toBe(200);
    const result = res.json as { status: string; confirmedBy: string; activityId: string };
    expect(result.status).toBe('final');
    expect(result.confirmedBy).toBe(CONFIRMER);
    expect(noteById(noteId)?.status).toBe('final');
    expect(timelineCount(leadId, 'note_added')).toBe(before + 1);
    // The landed activity carries the confirmer (§I-AI recorded action).
    const landed = (db.activitiesByLead.get(leadId) ?? []).find(
      (a) => a.type === 'note_added' && (a.payload as { noteId?: string }).noteId === noteId,
    );
    expect(landed?.userId).toBe(CONFIRMER);
    expect((landed?.payload as { confirmedBy?: string }).confirmedBy).toBe(CONFIRMER);
    expect((landed?.payload as { aiGenerated?: boolean }).aiGenerated).toBe(true);
  });

  test('400 without a confirmedBy (no final without a recorded user, §I-AI)', async () => {
    const { noteId } = await makeDraft();
    const res = await req('POST', `/ai/call-summaries/${noteId}/confirm`, {});
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe('VALIDATION_FAILED');
  });

  test('409 on a second confirm (already final)', async () => {
    const { noteId } = await makeDraft();
    await req('POST', `/ai/call-summaries/${noteId}/confirm`, { confirmedBy: CONFIRMER });
    const again = await req('POST', `/ai/call-summaries/${noteId}/confirm`, {
      confirmedBy: CONFIRMER,
    });
    expect(again.status).toBe(409);
    expect(errorCode(again.json)).toBe('CONFLICT');
  });

  test('404 when the note does not exist', async () => {
    const res = await req(
      'POST',
      '/ai/call-summaries/88888888-8888-4888-8888-888888888888/confirm',
      {
        confirmedBy: CONFIRMER,
      },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /ai/email-drafts (never auto-sent)', () => {
  test('returns a composer draft with a body; empty instruction is 400', async () => {
    const ok = await req('POST', '/ai/email-drafts', {
      instruction: 'Write a friendly intro to North Labs about saving reps time.',
      threadCtx: { subject: 'Intro', recentMessages: [] },
    });
    expect(ok.status).toBe(200);
    expect((ok.json as { body: string }).body.length).toBeGreaterThan(0);

    const bad = await req('POST', '/ai/email-drafts', { instruction: '   ' });
    expect(bad.status).toBe(400);
    expect(errorCode(bad.json)).toBe('VALIDATION_FAILED');
  });
});

describe('POST /ai/smart-view (NL → DSL, re-parsed)', () => {
  test('valid NL yields DSL + AST', async () => {
    const res = await req('POST', '/ai/smart-view', { query: 'show me won deals' });
    expect(res.status).toBe(200);
    const body = res.json as { dsl: string; ast: unknown };
    expect(body.dsl).toBe('status = "Won"');
    expect(body.ast).toBeTypeOf('object');
  });

  test('invalid AI DSL is a 400 VALIDATION_FAILED carrying rawDsl + position', async () => {
    // The `raw:` hook pins the model output verbatim (mirrors MockAIProvider
    // .scriptSmartView, which can emit INVALID DSL) so the guardrail is exercised.
    const res = await req('POST', '/ai/smart-view', { query: 'raw: status ==' });
    expect(res.status).toBe(400);
    expect(errorCode(res.json)).toBe('VALIDATION_FAILED');
    const details = (res.json as { error: { details?: { rawDsl?: string; position?: unknown } } })
      .error.details;
    expect(details?.rawDsl).toBe('status ==');
    expect(details?.position).toBeDefined();
  });
});
