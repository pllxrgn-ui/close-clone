import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import {
  ActorNotAllowedError,
  InvalidTriageCursorError,
  ThreadNotFoundError,
  TriageConflictError,
  TriageLeadNotFoundError,
  ignoreThread,
  listAmbiguousThreads,
  resolveThreadToLead,
  type TriageListOptions,
} from '../services/email/index.ts';
import { sendError } from './http.ts';

/**
 * Ambiguity triage queue HTTP surface (CONTRACTS §C7/§C8, task 2c).
 *
 *   GET  /api/v1/emails/triage                    — page the ambiguous threads
 *   POST /api/v1/emails/triage/:threadId/resolve  — attach a lead (human decision)
 *   POST /api/v1/emails/triage/:threadId/ignore   — mark not-a-lead
 *
 * The mutations are audit-friendly and RBAC-safe: the engine records the actor in
 * `audit_log` and refuses any actor that is not a valid, ACTIVE user. Until the
 * session/auth layer (5a) lands, the actor is carried explicitly in the request
 * body — `actorFrom` is the single seam that will instead read the authenticated
 * principal. All lead attachment goes through the same engine path ingest uses, so
 * the API cannot bypass the exactly-once activity rule (CONTRACTS §C4).
 */

export interface EmailTriageRouteDeps {
  db: Db;
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

const threadParamsSchema = z.object({
  threadId: z.string().uuid(),
});

const resolveBodySchema = z.object({
  leadId: z.string().uuid(),
  actorId: z.string().uuid(),
  reason: z.string().max(2000).optional(),
});

const ignoreBodySchema = z.object({
  actorId: z.string().uuid(),
  reason: z.string().max(2000).optional(),
});

/** Map an engine triage error to its C8 envelope; null if not a triage error. */
function mapTriageError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof ThreadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof TriageLeadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof TriageConflictError) return sendError(reply, 'CONFLICT', err.message);
  if (err instanceof ActorNotAllowedError) return sendError(reply, 'FORBIDDEN', err.message);
  if (err instanceof InvalidTriageCursorError)
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  return null;
}

export function registerEmailTriageRoutes(app: FastifyInstance, deps: EmailTriageRouteDeps): void {
  // GET /api/v1/emails/triage → { items, nextCursor? }
  app.get('/api/v1/emails/triage', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid triage query', parsed.error.flatten());
    }
    const options: TriageListOptions = {
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
    };
    try {
      const page = await listAmbiguousThreads(deps.db, options);
      return reply.send(page);
    } catch (err) {
      const mapped = mapTriageError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // POST /api/v1/emails/triage/:threadId/resolve  { leadId, actorId, reason? }
  app.post('/api/v1/emails/triage/:threadId/resolve', async (request, reply) => {
    const params = threadParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid thread id', params.error.flatten());
    }
    const body = resolveBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid resolve request', body.error.flatten());
    }
    try {
      const result = await resolveThreadToLead(deps.db, {
        threadId: params.data.threadId,
        leadId: body.data.leadId,
        actorId: body.data.actorId,
        ...(body.data.reason !== undefined ? { reason: body.data.reason } : {}),
      });
      return reply.send(result);
    } catch (err) {
      const mapped = mapTriageError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // POST /api/v1/emails/triage/:threadId/ignore  { actorId, reason? }
  app.post('/api/v1/emails/triage/:threadId/ignore', async (request, reply) => {
    const params = threadParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid thread id', params.error.flatten());
    }
    const body = ignoreBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid ignore request', body.error.flatten());
    }
    try {
      const result = await ignoreThread(deps.db, {
        threadId: params.data.threadId,
        actorId: body.data.actorId,
        ...(body.data.reason !== undefined ? { reason: body.data.reason } : {}),
      });
      return reply.send(result);
    } catch (err) {
      const mapped = mapTriageError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
