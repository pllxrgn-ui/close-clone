import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import {
  InvalidActorError,
  InvalidCursorError,
  SnippetNotFoundError,
  createSnippet,
  deleteSnippet,
  getSnippet,
  listSnippets,
  updateSnippet,
  type ListSnippetsOptions,
} from '../services/templates/index.ts';
import { sendError } from './http.ts';

/**
 * Snippets REST surface (CONTRACTS §C7 `snippets`, task 2d). Snippets are personal
 * (owner-scoped); every route resolves against the acting user. As with templates,
 * the actor is carried explicitly (`actorId`) until 5a's session layer lands.
 */

export interface SnippetRouteDeps {
  db: Db;
}

const listQuerySchema = z.object({
  actorId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

const createBodySchema = z.object({
  actorId: z.string().uuid(),
  shortcut: z.string().min(1).max(100),
  body: z.string().max(100_000),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

const updateBodySchema = z.object({
  actorId: z.string().uuid(),
  shortcut: z.string().min(1).max(100).optional(),
  body: z.string().max(100_000).optional(),
});

const actorBodySchema = z.object({ actorId: z.string().uuid() });

function mapSnippetError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof SnippetNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof InvalidActorError) return sendError(reply, 'FORBIDDEN', err.message);
  if (err instanceof InvalidCursorError) return sendError(reply, 'VALIDATION_FAILED', err.message);
  return null;
}

export function registerSnippetRoutes(app: FastifyInstance, deps: SnippetRouteDeps): void {
  app.get('/api/v1/snippets', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid snippets query',
        parsed.error.flatten(),
      );
    }
    const options: ListSnippetsOptions = {
      actorId: parsed.data.actorId,
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
    };
    try {
      return reply.send(await listSnippets(deps.db, options));
    } catch (err) {
      const mapped = mapSnippetError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.post('/api/v1/snippets', async (request, reply) => {
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid snippet', body.error.flatten());
    }
    try {
      const created = await createSnippet(deps.db, {
        actorId: body.data.actorId,
        shortcut: body.data.shortcut,
        body: body.data.body,
      });
      return reply.status(201).send(created);
    } catch (err) {
      const mapped = mapSnippetError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.get('/api/v1/snippets/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid snippet id', params.error.flatten());
    }
    const query = z.object({ actorId: z.string().uuid() }).safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'actorId is required', query.error.flatten());
    }
    try {
      return reply.send(await getSnippet(deps.db, params.data.id, query.data.actorId));
    } catch (err) {
      const mapped = mapSnippetError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.patch('/api/v1/snippets/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid snippet id', params.error.flatten());
    }
    const body = updateBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid snippet patch', body.error.flatten());
    }
    try {
      const updated = await updateSnippet(deps.db, params.data.id, {
        actorId: body.data.actorId,
        ...(body.data.shortcut !== undefined ? { shortcut: body.data.shortcut } : {}),
        ...(body.data.body !== undefined ? { body: body.data.body } : {}),
      });
      return reply.send(updated);
    } catch (err) {
      const mapped = mapSnippetError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.delete('/api/v1/snippets/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid snippet id', params.error.flatten());
    }
    const body = actorBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'actorId is required', body.error.flatten());
    }
    try {
      await deleteSnippet(deps.db, params.data.id, body.data.actorId);
      return reply.send({ ok: true });
    } catch (err) {
      const mapped = mapSnippetError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
