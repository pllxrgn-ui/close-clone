import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import { templateChannelValues } from '@switchboard/shared';
import {
  InvalidActorError,
  InvalidCursorError,
  TemplateForbiddenError,
  TemplateNotFoundError,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  type ListTemplatesOptions,
} from '../services/templates/index.ts';
import { sendError } from './http.ts';

/**
 * Templates REST surface (CONTRACTS §C7 `templates`, task 2d).
 *
 *   GET    /api/v1/templates                — page own + shared (channel filter)
 *   POST   /api/v1/templates                — create (owned)
 *   GET    /api/v1/templates/:id            — read (owner or shared)
 *   PATCH  /api/v1/templates/:id            — update (owner only)
 *   DELETE /api/v1/templates/:id            — delete (owner only)
 *
 * Until the session/auth layer (5a) lands, the acting user is carried explicitly
 * (`actorId` in body / query) — the single seam that will instead read the
 * authenticated principal. Visibility + ownership are enforced in the engine, so
 * the API cannot see or mutate another rep's private template.
 */

export interface TemplateRouteDeps {
  db: Db;
}

const channelSchema = z.enum(templateChannelValues);

const listQuerySchema = z.object({
  actorId: z.string().uuid(),
  channel: channelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

const createBodySchema = z.object({
  actorId: z.string().uuid(),
  name: z.string().min(1).max(200),
  channel: channelSchema,
  subject: z.string().max(2000).nullish(),
  body: z.string().max(100_000),
  shared: z.boolean().optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

const updateBodySchema = z.object({
  actorId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  channel: channelSchema.optional(),
  subject: z.string().max(2000).nullish(),
  body: z.string().max(100_000).optional(),
  shared: z.boolean().optional(),
});

const actorBodySchema = z.object({ actorId: z.string().uuid() });

/** Map a templates engine error to its C8 envelope; null if not one. */
function mapTemplateError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof TemplateNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof TemplateForbiddenError) return sendError(reply, 'FORBIDDEN', err.message);
  if (err instanceof InvalidActorError) return sendError(reply, 'FORBIDDEN', err.message);
  if (err instanceof InvalidCursorError) return sendError(reply, 'VALIDATION_FAILED', err.message);
  return null;
}

export function registerTemplateRoutes(app: FastifyInstance, deps: TemplateRouteDeps): void {
  app.get('/api/v1/templates', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid templates query',
        parsed.error.flatten(),
      );
    }
    const options: ListTemplatesOptions = {
      actorId: parsed.data.actorId,
      ...(parsed.data.channel !== undefined ? { channel: parsed.data.channel } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
    };
    try {
      return reply.send(await listTemplates(deps.db, options));
    } catch (err) {
      const mapped = mapTemplateError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.post('/api/v1/templates', async (request, reply) => {
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid template', body.error.flatten());
    }
    try {
      const created = await createTemplate(deps.db, {
        actorId: body.data.actorId,
        name: body.data.name,
        channel: body.data.channel,
        body: body.data.body,
        ...(body.data.subject !== undefined ? { subject: body.data.subject } : {}),
        ...(body.data.shared !== undefined ? { shared: body.data.shared } : {}),
      });
      return reply.status(201).send(created);
    } catch (err) {
      const mapped = mapTemplateError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.get('/api/v1/templates/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid template id', params.error.flatten());
    }
    const query = z.object({ actorId: z.string().uuid() }).safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'actorId is required', query.error.flatten());
    }
    try {
      return reply.send(await getTemplate(deps.db, params.data.id, query.data.actorId));
    } catch (err) {
      const mapped = mapTemplateError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.patch('/api/v1/templates/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid template id', params.error.flatten());
    }
    const body = updateBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid template patch', body.error.flatten());
    }
    try {
      const updated = await updateTemplate(deps.db, params.data.id, {
        actorId: body.data.actorId,
        ...(body.data.name !== undefined ? { name: body.data.name } : {}),
        ...(body.data.channel !== undefined ? { channel: body.data.channel } : {}),
        ...(body.data.subject !== undefined ? { subject: body.data.subject } : {}),
        ...(body.data.body !== undefined ? { body: body.data.body } : {}),
        ...(body.data.shared !== undefined ? { shared: body.data.shared } : {}),
      });
      return reply.send(updated);
    } catch (err) {
      const mapped = mapTemplateError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.delete('/api/v1/templates/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid template id', params.error.flatten());
    }
    const body = actorBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'actorId is required', body.error.flatten());
    }
    try {
      await deleteTemplate(deps.db, params.data.id, body.data.actorId);
      return reply.send({ ok: true });
    } catch (err) {
      const mapped = mapTemplateError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
