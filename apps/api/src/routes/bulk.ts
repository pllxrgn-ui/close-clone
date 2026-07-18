import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import type { ActivityWebhookEmitter } from '../services/activity/index.ts';
import type { QueueDriver } from '../queue/index.ts';
import {
  BulkInputError,
  BulkService,
  BulkTargetError,
  type BulkAction,
  type BulkInput,
} from '../services/bulk/index.ts';
import {
  rawClientOf,
  SmartViewInputError,
  ParseError,
  type RawQueryable,
} from '../services/smartviews/index.ts';
import { SequenceNotFoundError, SequenceValidationError } from '../services/sequences/index.ts';
import { sendError } from './http.ts';

/**
 * Bulk-action REST surface (CONTRACTS §C7 `bulk`, Task R3):
 *
 *   POST /api/v1/bulk  { smartViewId | ast, action, params } → { jobId, summary … }
 *
 * Resolves the target set by compiling the view/ast through the SINGLE query
 * authority (C3), then applies one action across it through the engine services —
 * the ActivityWriter for C4 events, the sequence engine for enroll. Compliance
 * rails hold when invoked via the API (I-RAIL-API): a DNC lead/contact is never
 * enrolled, and DNC set/clear requires an audit reason. Same composition seams as
 * the other routes: `getActor` (the acting user, recorded on every event + the
 * `me` binding) and an optional RBAC preHandler.
 *
 * The web bulk bar currently fans out client-side (PATCH /leads/:id + the enroll
 * route + a client-side CSV) and does NOT call this endpoint; it is the additive
 * C7 server-side bulk (see the task report). No enums / namespaces / parameter
 * properties (host type-stripping constraint).
 */

export interface BulkActor {
  userId: string;
}

export interface BulkRouteDeps {
  db: Db;
  /** Raw client for the compiler's `$n` SQL; derived from `db.$client` if omitted. */
  client?: RawQueryable;
  /** Org timezone for relative-date resolution (C3). */
  orgTimezone: string;
  /** Sequence wake-up queue (enroll enqueues per-intent jobs). */
  queue: QueueDriver;
  /** Injectable clock (event `occurredAt` + enroll due dates). Defaults to `Date`. */
  now?: () => Date;
  /** Fans bulk lead changes onto activity.recorded webhooks. */
  activityEmitter?: ActivityWebhookEmitter;
  /** Resolve the acting user; `null` ⇒ fall back to `defaultUserId`. */
  getActor?: (request: FastifyRequest) => BulkActor | null | Promise<BulkActor | null>;
  /** Acting-user fallback + `me` binding when there is no resolved actor. */
  defaultUserId: string;
  /** Optional RBAC gate(s) run before the handler (orchestrator-wired). */
  preHandler?: import('fastify').preHandlerHookHandler | import('fastify').preHandlerHookHandler[];
}

const bulkBodySchema = z.object({
  smartViewId: z.string().uuid().optional(),
  ast: z.unknown().optional(),
  action: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

/** Map a bulk/engine error to its §C8 reply; null ⇒ not ours (rethrow → 500). */
function mapBulkError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof BulkInputError) return sendError(reply, 'VALIDATION_FAILED', err.message);
  if (err instanceof BulkTargetError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof SequenceNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof SequenceValidationError) {
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  }
  if (err instanceof SmartViewInputError) return sendError(reply, 'VALIDATION_FAILED', err.message);
  if (err instanceof ParseError) {
    return sendError(reply, 'VALIDATION_FAILED', err.message, { position: err.position });
  }
  return null;
}

export function registerBulkRoutes(app: FastifyInstance, deps: BulkRouteDeps): void {
  const client = deps.client ?? rawClientOf(deps.db);
  const service = new BulkService({
    db: deps.db,
    client,
    orgTimezone: deps.orgTimezone,
    queue: deps.queue,
    now: deps.now ?? ((): Date => new Date()),
    ...(deps.activityEmitter !== undefined ? { emitter: deps.activityEmitter } : {}),
  });
  const routeOpts = deps.preHandler !== undefined ? { preHandler: deps.preHandler } : {};

  app.post('/api/v1/bulk', routeOpts, async (request, reply) => {
    const parsed = bulkBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid bulk request', parsed.error.flatten());
    }

    const actor = deps.getActor ? await deps.getActor(request) : null;
    const userId = actor?.userId ?? deps.defaultUserId;

    const input: BulkInput = {
      action: parsed.data.action as BulkAction,
      ...(parsed.data.smartViewId !== undefined ? { smartViewId: parsed.data.smartViewId } : {}),
      ...(parsed.data.ast !== undefined ? { ast: parsed.data.ast } : {}),
      ...(parsed.data.params !== undefined ? { params: parsed.data.params } : {}),
    };

    try {
      const result = await service.run(input, { userId });
      return reply.send(result);
    } catch (err) {
      const mapped = mapBulkError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
