import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { noteSchema, type ActivityType } from '@switchboard/shared';

import { activities, leads, notes, users, type ActivityRow } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { registerNotesRoutes } from './notes.ts';

/**
 * Notes CRUD routes (CONTRACTS §C7 `notes`, §C4 `note_added`, §C8 errors, §I-AI).
 * Drives the plugin through `fastify.inject` against PGlite. Asserts the plain-
 * array read, the `note_added` emission on finalization (POST final / PATCH
 * draft→final), the C8 failure paths, and — critically — the §I-AI guard: an
 * AI-generated draft can NOT be finalized through this endpoint (that is the AI
 * confirm route's job), and this endpoint never creates an AI note.
 */

const USER = '00000000-0000-4000-8000-0000000000d1';
const LEAD = '11111111-0000-4000-8000-0000000000e1';
const MISSING = '99999999-0000-4000-8000-000000000999';

let ctx: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);
  await ctx.db
    .insert(users)
    .values([
      { id: USER, email: 'rep@example.com', name: 'Rep', role: 'rep', idpSubject: 'idp|d1' },
    ]);
  await ctx.db.insert(leads).values([{ id: LEAD, name: 'Acme', ownerId: USER }]);

  app = Fastify({ logger: false });
  registerNotesRoutes(app, { db: ctx.db });
  await app.ready();
}, 120_000);

beforeEach(async () => {
  await ctx.db.delete(activities);
  await ctx.db.delete(notes);
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

async function eventsOfType(leadId: string, type: ActivityType): Promise<ActivityRow[]> {
  return ctx.db
    .select()
    .from(activities)
    .where(and(eq(activities.leadId, leadId), eq(activities.type, type)));
}

async function post(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/notes', payload: body });
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('POST /api/v1/notes', () => {
  test('final human note → 201, aiGenerated false, emits note_added', async () => {
    const res = await post({
      leadId: LEAD,
      bodyMd: 'Called, will follow up',
      authorId: USER,
      actorId: USER,
    });
    expect(res.statusCode).toBe(201);
    const note = res.json<Record<string, unknown>>();
    expect(note.status).toBe('final');
    expect(note.aiGenerated).toBe(false);
    expect(note.bodyMd).toBe('Called, will follow up');
    expect(note.createdAt).toMatch(ISO_RE);

    const added = await eventsOfType(LEAD, 'note_added');
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toMatchObject({ noteId: note.id, aiGenerated: false });
    expect(added[0]?.userId).toBe(USER);
  });

  test('draft human note → 201, no note_added event', async () => {
    const res = await post({ leadId: LEAD, bodyMd: 'scratch', status: 'draft' });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ status: string }>().status).toBe('draft');
    expect(await eventsOfType(LEAD, 'note_added')).toHaveLength(0);
  });

  test('aiGenerated:true → 400 (created via the AI route, §I-AI)', async () => {
    const res = await post({ leadId: LEAD, bodyMd: 'x', aiGenerated: true });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  test('unknown leadId → 404; empty body → 400; unknown authorId → 400', async () => {
    expect((await post({ leadId: MISSING, bodyMd: 'x' })).statusCode).toBe(404);
    expect((await post({ leadId: LEAD, bodyMd: '' })).statusCode).toBe(400);
    expect((await post({ leadId: LEAD, bodyMd: 'x', authorId: MISSING })).statusCode).toBe(400);
  });
});

describe('GET /api/v1/notes', () => {
  test('?leadId= returns a plain array', async () => {
    await post({ leadId: LEAD, bodyMd: 'one' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/notes?leadId=${LEAD}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<unknown>();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });

  test('missing leadId → 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes' })).statusCode).toBe(400);
  });

  test('GET /:id unknown → 404; non-uuid → 400', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/v1/notes/${MISSING}` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes/abc' })).statusCode).toBe(400);
  });
});

describe('PATCH /api/v1/notes/:id', () => {
  test('human draft → final emits note_added', async () => {
    const created = (await post({ leadId: LEAD, bodyMd: 'draft body', status: 'draft' })).json<{
      id: string;
    }>();
    expect(await eventsOfType(LEAD, 'note_added')).toHaveLength(0);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${created.id}`,
      payload: { status: 'final', actorId: USER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('final');
    expect(await eventsOfType(LEAD, 'note_added')).toHaveLength(1);
  });

  test('body-only edit → no event, body updated', async () => {
    const created = (await post({ leadId: LEAD, bodyMd: 'v1', status: 'draft' })).json<{
      id: string;
    }>();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${created.id}`,
      payload: { bodyMd: 'v2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ bodyMd: string }>().bodyMd).toBe('v2');
    expect(await eventsOfType(LEAD, 'note_added')).toHaveLength(0);
  });

  test('§I-AI: finalizing an AI-generated draft is refused (400), note stays draft', async () => {
    const aiNoteId = randomUUID();
    // Simulate what services/ai's generateCallSummaryDraft writes: an AI draft.
    await ctx.db.insert(notes).values({
      id: aiNoteId,
      leadId: LEAD,
      authorId: null,
      bodyMd: '**Call summary (AI-generated draft)**',
      status: 'draft',
      aiGenerated: true,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${aiNoteId}`,
      payload: { status: 'final' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');

    // The AI note must NOT have been finalized, and no note_added may have fired.
    const rows = await ctx.db.select().from(notes).where(eq(notes.id, aiNoteId)).limit(1);
    expect(rows[0]?.status).toBe('draft');
    expect(await eventsOfType(LEAD, 'note_added')).toHaveLength(0);
  });

  test('§I-AI: editing an AI draft body is allowed and emits no event', async () => {
    const aiNoteId = randomUUID();
    await ctx.db.insert(notes).values({
      id: aiNoteId,
      leadId: LEAD,
      authorId: null,
      bodyMd: 'ai draft',
      status: 'draft',
      aiGenerated: true,
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${aiNoteId}`,
      payload: { bodyMd: 'ai draft (edited)' },
    });
    expect(res.statusCode).toBe(200);
    expect(await eventsOfType(LEAD, 'note_added')).toHaveLength(0);
  });

  test('empty patch → 400; unknown id → 404', async () => {
    const created = (await post({ leadId: LEAD, bodyMd: 'x' })).json<{ id: string }>();
    expect(
      (await app.inject({ method: 'PATCH', url: `/api/v1/notes/${created.id}`, payload: {} }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/notes/${MISSING}`,
          payload: { status: 'final' },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('DELETE /api/v1/notes/:id', () => {
  test('deletes, 204, GET → 404', async () => {
    const created = (await post({ leadId: LEAD, bodyMd: 'x' })).json<{ id: string }>();
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/notes/${created.id}` })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/notes/${created.id}` })).statusCode,
    ).toBe(404);
  });

  test('unknown id → 404', async () => {
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/notes/${MISSING}` })).statusCode,
    ).toBe(404);
  });
});

describe('DTO conformance (§C1/§C7 Note shape)', () => {
  test('POST result and list items all parse as noteSchema', async () => {
    const created = (await post({ leadId: LEAD, bodyMd: 'body', authorId: USER })).json();
    expect(() => noteSchema.strict().parse(created)).not.toThrow();

    const list = await app.inject({ method: 'GET', url: `/api/v1/notes?leadId=${LEAD}` });
    for (const item of list.json<unknown[]>()) {
      expect(() => noteSchema.strict().parse(item)).not.toThrow();
    }
  });
});
