import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import {
  WebhookHasDeliveriesError,
  WebhookSubscriptionNotFoundError,
  WebhookSubscriptionService,
  WebhookValidationError,
} from '../services/webhooks/index.ts';
import { sendError } from './http.ts';

/**
 * Admin webhook-subscription management (Task 5c, CONTRACTS §C7 `admin/*`). Factory
 * routes under `/api/v1/admin/webhook-subscriptions`:
 *
 *   POST   /                     — create (returns the signing secret ONCE)
 *   GET    /                     — list (keyset; secret-free)
 *   GET    /:id                  — read (secret-free)
 *   PATCH  /:id                  — update url/events/active
 *   POST   /:id/rotate-secret    — rotate (returns the NEW secret once)
 *   DELETE /:id                  — hard delete (409 if it has delivery history)
 *
 * RBAC is the INJECTED `adminGuard` (Task 5a wires the real one). The signing
 * secret is returned ONLY by create and rotate-secret; every read view omits it
 * (D-021). CONTRACT FRICTION (reported): as with tokens, the audit catalog lacks
 * `admin.webhook_*` actions, so subscription lifecycle is not audited here yet.
 */

const eventsSchema = z.array(z.string().min(1)).min(1).max(64);

const createBodySchema = z.object({
  url: z.string().min(1).max(2000),
  events: eventsSchema,
  secret: z.string().min(8).max(200).optional(),
  isActive: z.boolean().optional(),
});

const updateBodySchema = z
  .object({
    url: z.string().min(1).max(2000).optional(),
    events: eventsSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.url !== undefined || v.events !== undefined || v.isActive !== undefined, {
    message: 'at least one field must be provided',
  });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  activeOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

export interface WebhookSubscriptionRouteDeps {
  db: Db;
  /** Injected admin RBAC guard (Task 5a). Runs before every handler. */
  adminGuard: preHandlerHookHandler;
}

function mapError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof WebhookSubscriptionNotFoundError)
    return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof WebhookHasDeliveriesError) return sendError(reply, 'CONFLICT', err.message);
  if (err instanceof WebhookValidationError)
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  return null;
}

export function registerWebhookSubscriptionRoutes(
  app: FastifyInstance,
  deps: WebhookSubscriptionRouteDeps,
): void {
  const service = new WebhookSubscriptionService(deps.db);
  const base = '/api/v1/admin/webhook-subscriptions';
  const guard = { preHandler: deps.adminGuard };

  app.post(base, guard, async (request, reply) => {
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid subscription', body.error.flatten());
    }
    try {
      const created = await service.create({
        url: body.data.url,
        events: body.data.events,
        ...(body.data.secret !== undefined ? { secret: body.data.secret } : {}),
        ...(body.data.isActive !== undefined ? { isActive: body.data.isActive } : {}),
      });
      return reply.status(201).send(created);
    } catch (err) {
      const mapped = mapError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.get(base, guard, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid query', query.error.flatten());
    }
    try {
      const page = await service.list({
        ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
        ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
        ...(query.data.activeOnly !== undefined ? { activeOnly: query.data.activeOnly } : {}),
      });
      return reply.send(page);
    } catch (err) {
      const mapped = mapError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.get(`${base}/:id`, guard, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    try {
      return reply.send(await service.get(params.data.id));
    } catch (err) {
      const mapped = mapError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.patch(`${base}/:id`, guard, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    const body = updateBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid patch', body.error.flatten());
    }
    try {
      const updated = await service.update(params.data.id, {
        ...(body.data.url !== undefined ? { url: body.data.url } : {}),
        ...(body.data.events !== undefined ? { events: body.data.events } : {}),
        ...(body.data.isActive !== undefined ? { isActive: body.data.isActive } : {}),
      });
      return reply.send(updated);
    } catch (err) {
      const mapped = mapError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.post(`${base}/:id/rotate-secret`, guard, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    try {
      return reply.send(await service.rotateSecret(params.data.id));
    } catch (err) {
      const mapped = mapError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.delete(`${base}/:id`, guard, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    try {
      await service.remove(params.data.id);
      return reply.status(204).send();
    } catch (err) {
      const mapped = mapError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
