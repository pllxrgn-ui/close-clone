import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import {
  createSequence,
  enrollContacts,
  enrollmentsForSequence,
  getSequence,
  listSequences,
  updateSequence,
  SequenceNotFoundError,
  SequenceValidationError,
  type EnrollInput,
  type EnrollmentDeps,
} from '../services/sequences/index.ts';
import { sendError } from './http.ts';

/**
 * Sequences REST surface (CONTRACTS §C7 `sequences` + `POST /sequences/:id/enroll`,
 * task 2e).
 *
 *   POST  /api/v1/sequences               — create (name + ordered steps)
 *   GET   /api/v1/sequences               — page (keyset)
 *   GET   /api/v1/sequences/:id           — read (with steps)
 *   PATCH /api/v1/sequences/:id           — update name/status (archive)
 *   POST  /api/v1/sequences/:id/enroll    — bulk enroll contacts
 *   GET   /api/v1/sequences/:id/enrollments — roster
 *
 * Enroll goes THROUGH the engine (`enrollContacts`), which owns intent scheduling
 * and the never-event rails at send time — the API has no other path to a send.
 */

export type SequenceRouteDeps = EnrollmentDeps;

const stepSchema = z.object({
  type: z.enum(['email', 'call_task', 'sms']),
  delayHours: z.number().int().min(0).max(24 * 365).optional(),
  templateId: z.string().uuid().nullish(),
  requiresReview: z.boolean().optional(),
  condition: z.record(z.unknown()).nullish(),
});

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  status: z.enum(['active', 'archived']).optional(),
  settings: z.record(z.unknown()).optional(),
  steps: z.array(stepSchema).min(1),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

const updateBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'archived']).optional(),
  settings: z.record(z.unknown()).optional(),
});

const enrollBodySchema = z.object({
  enrolledBy: z.string().uuid().optional(),
  emailAccountId: z.string().uuid().optional(),
  targets: z
    .array(z.object({ leadId: z.string().uuid(), contactId: z.string().uuid() }))
    .min(1)
    .max(1000),
});

function mapSequenceError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof SequenceNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof SequenceValidationError) return sendError(reply, 'VALIDATION_FAILED', err.message);
  return null;
}

export function registerSequenceRoutes(app: FastifyInstance, deps: SequenceRouteDeps): void {
  const db: Db = deps.db;

  app.post('/api/v1/sequences', async (request, reply) => {
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid sequence', body.error.flatten());
    }
    try {
      const created = await createSequence(db, {
        name: body.data.name,
        ...(body.data.status !== undefined ? { status: body.data.status } : {}),
        ...(body.data.settings !== undefined ? { settings: body.data.settings } : {}),
        steps: body.data.steps.map((s) => ({
          type: s.type,
          ...(s.delayHours !== undefined ? { delayHours: s.delayHours } : {}),
          ...(s.templateId !== undefined ? { templateId: s.templateId } : {}),
          ...(s.requiresReview !== undefined ? { requiresReview: s.requiresReview } : {}),
          ...(s.condition !== undefined ? { condition: s.condition } : {}),
        })),
      });
      return reply.status(201).send(created);
    } catch (err) {
      const mapped = mapSequenceError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.get('/api/v1/sequences', async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid query', query.error.flatten());
    }
    try {
      return reply.send(
        await listSequences(db, {
          ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
          ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
          ...(query.data.status !== undefined ? { status: query.data.status } : {}),
        }),
      );
    } catch (err) {
      const mapped = mapSequenceError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.get('/api/v1/sequences/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    try {
      return reply.send(await getSequence(db, params.data.id));
    } catch (err) {
      const mapped = mapSequenceError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.patch('/api/v1/sequences/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    const body = updateBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid patch', body.error.flatten());
    }
    try {
      const updated = await updateSequence(db, params.data.id, {
        ...(body.data.name !== undefined ? { name: body.data.name } : {}),
        ...(body.data.status !== undefined ? { status: body.data.status } : {}),
        ...(body.data.settings !== undefined ? { settings: body.data.settings } : {}),
      });
      return reply.send(updated);
    } catch (err) {
      const mapped = mapSequenceError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.post('/api/v1/sequences/:id/enroll', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    const body = enrollBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid enroll request', body.error.flatten());
    }
    const input: EnrollInput = {
      sequenceId: params.data.id,
      ...(body.data.enrolledBy !== undefined ? { enrolledBy: body.data.enrolledBy } : {}),
      ...(body.data.emailAccountId !== undefined ? { emailAccountId: body.data.emailAccountId } : {}),
      targets: body.data.targets,
    };
    try {
      const result = await enrollContacts(deps, input);
      return reply.send(result);
    } catch (err) {
      const mapped = mapSequenceError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.get('/api/v1/sequences/:id/enrollments', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    return reply.send({ items: await enrollmentsForSequence(db, params.data.id) });
  });
}
