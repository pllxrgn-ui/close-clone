import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import {
  InvalidThreadCursorError,
  ThreadNotFoundError,
  getThread,
  listThreads,
  type ListThreadsOptions,
} from '../services/email/index.ts';
import { sendError } from './http.ts';

/**
 * Email thread READ surface (CONTRACTS §C7 `emails` — threads read, task 2d).
 *
 *   GET /api/v1/emails/threads            — page threads (optional ?leadId=)
 *   GET /api/v1/emails/threads/:id        — a thread + its messages (oldest first)
 *
 * Read-only: the client uses this to render a lead's conversation and to pick the
 * message id to reply to (fed to POST /emails/send { inReplyToMessageId }).
 */

export interface EmailThreadRouteDeps {
  db: Db;
}

const listQuerySchema = z.object({
  leadId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

function mapThreadError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof ThreadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof InvalidThreadCursorError)
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  return null;
}

export function registerEmailThreadRoutes(app: FastifyInstance, deps: EmailThreadRouteDeps): void {
  app.get('/api/v1/emails/threads', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid threads query', parsed.error.flatten());
    }
    const options: ListThreadsOptions = {
      ...(parsed.data.leadId !== undefined ? { leadId: parsed.data.leadId } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
    };
    try {
      return reply.send(await listThreads(deps.db, options));
    } catch (err) {
      const mapped = mapThreadError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.get('/api/v1/emails/threads/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid thread id', params.error.flatten());
    }
    try {
      return reply.send(await getThread(deps.db, params.data.id));
    } catch (err) {
      const mapped = mapThreadError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
