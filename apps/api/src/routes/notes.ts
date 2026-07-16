import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { noteStatusSchema } from '@switchboard/shared';

import type { Db } from '../db/index.ts';
import { LeadNotFoundError } from '../services/activity/index.ts';
import {
  AiNoteFinalizeError,
  InvalidNoteReferenceError,
  NoteLeadNotFoundError,
  NoteNotFoundError,
  createNote,
  deleteNote,
  getNote,
  listNotesByLead,
  patchNote,
  type CreateNoteInput,
  type PatchNoteInput,
} from '../services/notes/index.ts';
import { sendError } from './http.ts';

/**
 * Notes CRUD routes (CONTRACTS §C7 `notes`). A Fastify plugin factory. This is
 * the human-notes surface; AI-generated notes are created + finalized by the AI
 * call-summary route (§I-AI, `routes/ai.ts`), never here.
 *
 *   GET    /api/v1/notes?leadId=   — a lead's notes as a plain array (newest first).
 *   GET    /api/v1/notes/:id
 *   POST   /api/v1/notes           — create a human note; `final` → `note_added`.
 *   PATCH  /api/v1/notes/:id       — body / status; human draft→final → `note_added`.
 *                                    Refuses to finalize an AI-generated note (§I-AI).
 *   DELETE /api/v1/notes/:id       — hard delete (no C4 event).
 */

export interface NotesRouteDeps {
  db: Db;
}

const leadQuerySchema = z.object({ leadId: z.string().uuid() });
const idParamSchema = z.object({ id: z.string().uuid() });

const createBodySchema = z.object({
  leadId: z.string().uuid(),
  bodyMd: z.string().min(1).max(100_000),
  status: noteStatusSchema.optional(),
  authorId: z.string().uuid().nullable().optional(),
  aiGenerated: z.boolean().optional(),
  actorId: z.string().uuid().optional(),
});

const patchBodySchema = z
  .object({
    bodyMd: z.string().min(1).max(100_000).optional(),
    status: noteStatusSchema.optional(),
    actorId: z.string().uuid().optional(),
  })
  .refine((v) => v.bodyMd !== undefined || v.status !== undefined, {
    message: 'provide bodyMd and/or status',
  });

/** Map a notes-service error to its C8 envelope; null if not a known error. */
function mapNoteError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof NoteNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof NoteLeadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof LeadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof InvalidNoteReferenceError) {
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  }
  if (err instanceof AiNoteFinalizeError) return sendError(reply, 'VALIDATION_FAILED', err.message);
  return null;
}

export function registerNotesRoutes(app: FastifyInstance, deps: NotesRouteDeps): void {
  const { db } = deps;

  // GET /api/v1/notes?leadId=
  app.get('/api/v1/notes', async (request, reply) => {
    const parsed = leadQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'notes requires ?leadId=<uuid>');
    }
    return reply.send(await listNotesByLead(db, parsed.data.leadId));
  });

  // GET /api/v1/notes/:id
  app.get('/api/v1/notes/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid note id');
    try {
      return reply.send(await getNote(db, params.data.id));
    } catch (err) {
      const mapped = mapNoteError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // POST /api/v1/notes
  app.post('/api/v1/notes', async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid note', parsed.error.flatten());
    }
    const d = parsed.data;
    // §I-AI: AI-generated notes are born (as drafts) by the AI call-summary route,
    // never here — reject an attempt to create one through the human notes surface.
    if (d.aiGenerated === true) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'AI-generated notes are created via POST /api/v1/ai/call-summaries, not this endpoint',
      );
    }
    const input: CreateNoteInput = {
      leadId: d.leadId,
      bodyMd: d.bodyMd,
      ...(d.status !== undefined ? { status: d.status } : {}),
      ...(d.authorId !== undefined ? { authorId: d.authorId } : {}),
      ...(d.actorId !== undefined ? { actorId: d.actorId } : {}),
    };
    try {
      const created = await createNote(db, input);
      return reply.status(201).send(created);
    } catch (err) {
      const mapped = mapNoteError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // PATCH /api/v1/notes/:id
  app.patch('/api/v1/notes/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid note id');
    const parsed = patchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid patch', parsed.error.flatten());
    }
    const d = parsed.data;
    const input: PatchNoteInput = {
      ...(d.bodyMd !== undefined ? { bodyMd: d.bodyMd } : {}),
      ...(d.status !== undefined ? { status: d.status } : {}),
      ...(d.actorId !== undefined ? { actorId: d.actorId } : {}),
    };
    try {
      const updated = await patchNote(db, params.data.id, input);
      return reply.send(updated);
    } catch (err) {
      const mapped = mapNoteError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // DELETE /api/v1/notes/:id
  app.delete('/api/v1/notes/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid note id');
    try {
      await deleteNote(db, params.data.id);
      return reply.status(204).send();
    } catch (err) {
      const mapped = mapNoteError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
