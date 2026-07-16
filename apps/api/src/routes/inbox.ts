import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import type { QueueDriver } from '../queue/index.ts';
import {
  approveReview,
  buildQueue,
  computeStats,
  InboxConflictError,
  InboxNotFoundError,
  InboxSuppressedError,
  loadDoneCandidates,
  loadOpenSnapshot,
  skipReview,
  computeSnooze,
  type InboxQueueResponse,
} from '../services/inbox/index.ts';
import { sendError } from './http.ts';

/**
 * Inbox routes (CONTRACTS §C7 D-030) — the rep's home queue as a real server-side
 * projection over Postgres, replacing the MVP's MSW/dev-only story. Shapes match
 * what the web `features/inbox/api/inbox.ts` already calls so flipping the web to
 * the real API is a drop-in:
 *
 *   GET  /api/v1/inbox                       → { items }         (merged queue)
 *   GET  /api/v1/inbox/stats                 → { needsYouNow, overdue, doneToday }
 *   POST /api/v1/inbox/reviews/:id/approve   → release to send (rails in dispatch)
 *   POST /api/v1/inbox/reviews/:id/skip      → terminal SKIPPED
 *   POST /api/v1/inbox/snooze {itemId}       → { id, snoozedUntil }  (not persisted)
 *
 * Rep-accessible (no admin guard), like the reference reads; the composition root
 * can layer auth at merge. Reply/complete are NOT here — they reuse the canonical
 * `POST /emails/send` · `/sms/send` · `PATCH /tasks/:id` (owned elsewhere).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

export interface InboxRouteDeps {
  db: Db;
  /** Injectable clock; anchors overdue / done-today math. Defaults to wall clock. */
  now?: () => Date;
  /** Optional queue: approve enqueues the released intent for immediate dispatch. */
  queue?: QueueDriver;
}

function mapInboxError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof InboxNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof InboxSuppressedError) return sendError(reply, 'SUPPRESSED', err.message);
  if (err instanceof InboxConflictError) return sendError(reply, 'CONFLICT', err.message);
  return null;
}

export function registerInboxRoutes(app: FastifyInstance, deps: InboxRouteDeps): void {
  const { db } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const reviewDeps = { now, ...(deps.queue !== undefined ? { queue: deps.queue } : {}) };

  app.get('/api/v1/inbox', async () => {
    const open = await loadOpenSnapshot(db, now().getTime());
    const body: InboxQueueResponse = { items: buildQueue(open, now().getTime()) };
    return body;
  });

  app.get('/api/v1/inbox/stats', async () => {
    const nowMs = now().getTime();
    const [open, done] = await Promise.all([
      loadOpenSnapshot(db, nowMs),
      loadDoneCandidates(db, nowMs),
    ]);
    return computeStats(open, done, nowMs);
  });

  app.post('/api/v1/inbox/reviews/:id/approve', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid review id', params.error.flatten());
    }
    try {
      return reply.send(await approveReview(db, params.data.id, reviewDeps));
    } catch (err) {
      const mapped = mapInboxError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.post('/api/v1/inbox/reviews/:id/skip', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid review id', params.error.flatten());
    }
    try {
      return reply.send(await skipReview(db, params.data.id, reviewDeps));
    } catch (err) {
      const mapped = mapInboxError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.post('/api/v1/inbox/snooze', async (request, reply) => {
    const body: unknown = request.body;
    const itemId =
      typeof body === 'object' && body !== null && 'itemId' in body
        ? (body as { itemId: unknown }).itemId
        : undefined;
    if (typeof itemId !== 'string' || itemId.trim().length === 0) {
      return sendError(reply, 'VALIDATION_FAILED', 'itemId is required');
    }
    return reply.send(computeSnooze(itemId, now().getTime()));
  });
}
