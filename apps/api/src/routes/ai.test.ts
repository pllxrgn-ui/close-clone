import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { calls, type Db } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { createMockASRProvider, type MockASRProvider } from '../providers/asr/index.ts';
import { createMockAIProvider, type MockAIProvider } from '../providers/ai/index.ts';
import { seedLead, seedUser, activitiesFor, notesFor } from '../services/telephony/test-helpers.ts';
import { registerAiRoutes } from './ai.ts';

/**
 * AI routes (tasks 3e/3g, CONTRACTS §C7/§C8). Drives the plugin through
 * `fastify.inject` on a real PGlite DB + the mock ASR/AI adapters. Pins §I-AI THROUGH
 * the API: generating a summary writes only a draft (no timeline event); only the
 * confirm route — which requires confirmedBy — flips it to final + emits note_added;
 * email drafts never send; NL→Smart View re-parses and 400s on invalid DSL.
 */

const NIL = '00000000-0000-4000-8000-0000000000ff';

let ctx: TestDb;
let db: Db;
let app: FastifyInstance;
let asr: MockASRProvider;
let ai: MockAIProvider;
let rep: string;
let lead: string;

async function seedCall(): Promise<string> {
  const rows = await db
    .insert(calls)
    .values({
      leadId: lead,
      userId: rep,
      direction: 'outbound',
      status: 'completed',
      recordingRef: 'rec-1',
    })
    .returning({ id: calls.id });
  return rows[0]!.id;
}

async function remountWithoutAsr(): Promise<void> {
  await app.close();
  app = Fastify();
  registerAiRoutes(app, { db, ai });
  await app.ready();
}

beforeEach(async () => {
  ctx = await createTestDb();
  db = ctx.db;
  asr = createMockASRProvider();
  ai = createMockAIProvider();
  rep = await seedUser(db, { name: 'Rep' });
  lead = await seedLead(db, { name: 'Acme', ownerId: rep });
  app = Fastify();
  registerAiRoutes(app, { db, asr, ai });
  await app.ready();
}, 120_000);

afterEach(async () => {
  await app.close();
  await ctx.close();
});

describe('POST /api/v1/ai/call-summaries (+ confirm) — §I-AI through the API', () => {
  test('reports transcription as unavailable when Anthropic is configured without Deepgram', async () => {
    await remountWithoutAsr();
    const callId = await seedCall();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/call-summaries',
      payload: { callId },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: { code: 'PROVIDER_ERROR', message: expect.stringMatching(/Deepgram/i) },
    });
  });

  test('generate writes a draft only; confirm flips to final + emits note_added', async () => {
    const callId = await seedCall();

    const gen = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/call-summaries',
      payload: { callId },
    });
    expect(gen.statusCode).toBe(200);
    const draft = gen.json() as { noteId: string; status: string; aiGenerated: boolean };
    expect(draft.status).toBe('draft');
    expect(draft.aiGenerated).toBe(true);

    // No timeline event yet.
    expect((await activitiesFor(db, lead)).filter((a) => a.type === 'note_added')).toHaveLength(0);
    expect((await notesFor(db, lead))[0]).toMatchObject({ status: 'draft', aiGenerated: true });

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/v1/ai/call-summaries/${draft.noteId}/confirm`,
      payload: { confirmedBy: rep },
    });
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { status: string }).status).toBe('final');

    const noteAdded = (await activitiesFor(db, lead)).filter((a) => a.type === 'note_added');
    expect(noteAdded).toHaveLength(1);
    expect(noteAdded[0]?.payload).toMatchObject({ confirmedBy: rep, aiGenerated: true });
    expect((await notesFor(db, lead))[0]?.status).toBe('final');
  });

  test('confirm WITHOUT confirmedBy is a 400 (no final without a recorded user)', async () => {
    const callId = await seedCall();
    const gen = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/call-summaries',
      payload: { callId },
    });
    const draft = gen.json() as { noteId: string };

    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/ai/call-summaries/${draft.noteId}/confirm`,
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
    // Still a draft, still no timeline event.
    expect((await notesFor(db, lead))[0]?.status).toBe('draft');
    expect((await activitiesFor(db, lead)).filter((a) => a.type === 'note_added')).toHaveLength(0);
  });

  test('confirm of an unknown note → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/ai/call-summaries/${NIL}/confirm`,
      payload: { confirmedBy: rep },
    });
    expect(res.statusCode).toBe(404);
  });

  test('generate for an unknown call → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/call-summaries',
      payload: { callId: NIL },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v1/ai/email-drafts', () => {
  test('returns a composer draft (never sent)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/email-drafts',
      payload: { instruction: 'Follow up on the quote', threadCtx: { subject: 'Quote' } },
    });
    expect(res.statusCode).toBe(200);
    const draft = res.json() as { subject?: string; body: string };
    expect(draft.body).toContain('Follow up on the quote');
    expect(draft.subject).toBe('Re: Quote');
  });

  test('empty instruction → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/email-drafts',
      payload: { instruction: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/v1/ai/smart-view', () => {
  test('valid NL → 200 with canonical dsl + ast', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/smart-view',
      payload: { query: 'all won deals' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { dsl: string; ast: unknown };
    expect(body.dsl).toBe('status = "Won"');
    expect(body.ast).toBeDefined();
  });

  test('AI-produced invalid DSL → 400 with the raw DSL surfaced (visible error)', async () => {
    ai.scriptSmartView('nonsense query', 'status = = broken');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/smart-view',
      payload: { query: 'nonsense query' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; details?: { rawDsl?: string } } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details?.rawDsl).toBe('status = = broken');
  });

  test('empty query → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/smart-view',
      payload: { query: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});
