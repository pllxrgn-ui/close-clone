import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { opportunityStatusSchema } from '@switchboard/shared';

import type { Db } from '../db/index.ts';
import { LeadNotFoundError } from '../services/activity/index.ts';
import {
  InvalidOpportunityCursorError,
  InvalidReferenceError,
  OpportunityLeadNotFoundError,
  OpportunityNotFoundError,
  createOpportunity,
  deleteOpportunity,
  getOpportunity,
  listOpportunities,
  listOpportunitiesByLead,
  patchOpportunity,
  type CreateOpportunityInput,
  type PatchOpportunityInput,
} from '../services/opportunities/index.ts';
import { sendError } from './http.ts';

/**
 * Opportunities CRUD routes (CONTRACTS §C7 `opportunities`). A Fastify plugin
 * factory following the repo's `register*Routes(app, deps)` convention. It is the
 * real-API drop-in for the web's MSW `opportunities` handlers, matching them path-
 * for-path and shape-for-shape so `VITE_API_MODE=real` needs zero web changes:
 *
 *   GET    /api/v1/opportunities            — no `leadId`: the pipeline board's
 *                                             keyset page `{ items, nextCursor? }`;
 *                                             WITH `leadId`: a lead's opportunities
 *                                             as a plain array (right-rail read).
 *   GET    /api/v1/opportunities/:id        — one opportunity.
 *   POST   /api/v1/opportunities            — create (→ `opportunity_created`).
 *   PATCH  /api/v1/opportunities/:id        — value/stage/confidence/close/status/…
 *                                             (stage move → `opportunity_stage_changed`;
 *                                             won|lost → `opportunity_closed`).
 *   DELETE /api/v1/opportunities/:id        — hard delete (no C4 event).
 *
 * The route is a thin translator: validate the shape, delegate to the service
 * (which owns the transaction + C4 event emission), map typed errors to §C8.
 */

export interface OpportunitiesRouteDeps {
  db: Db;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const getQuerySchema = z.object({
  leadId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const createBodySchema = z.object({
  leadId: z.string().uuid(),
  contactId: z.string().uuid().nullable().optional(),
  valueCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  stageId: z.string().uuid().nullable().optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  closeDate: z.string().regex(DATE_RE).nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  status: opportunityStatusSchema.optional(),
  note: z.string().max(10_000).nullable().optional(),
  actorId: z.string().uuid().optional(),
});

const patchBodySchema = z
  .object({
    valueCents: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    stageId: z.string().uuid().nullable().optional(),
    confidence: z.number().int().min(0).max(100).optional(),
    closeDate: z.string().regex(DATE_RE).nullable().optional(),
    ownerId: z.string().uuid().nullable().optional(),
    status: opportunityStatusSchema.optional(),
    note: z.string().max(10_000).nullable().optional(),
    contactId: z.string().uuid().nullable().optional(),
    actorId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      v.valueCents !== undefined ||
      v.currency !== undefined ||
      v.stageId !== undefined ||
      v.confidence !== undefined ||
      v.closeDate !== undefined ||
      v.ownerId !== undefined ||
      v.status !== undefined ||
      v.note !== undefined ||
      v.contactId !== undefined,
    { message: 'provide at least one field to update' },
  );

/** Map an opportunities-service error to its C8 envelope; null if not a known error. */
function mapOpportunityError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof OpportunityNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof OpportunityLeadNotFoundError) {
    return sendError(reply, 'NOT_FOUND', err.message);
  }
  if (err instanceof LeadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof InvalidReferenceError) {
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  }
  if (err instanceof InvalidOpportunityCursorError) {
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  }
  return null;
}

export function registerOpportunitiesRoutes(app: FastifyInstance, deps: OpportunitiesRouteDeps): void {
  const { db } = deps;

  // GET /api/v1/opportunities — board keyset (no leadId) OR per-lead array.
  app.get('/api/v1/opportunities', async (request, reply) => {
    const parsed = getQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid opportunities query',
        parsed.error.flatten(),
      );
    }
    if (parsed.data.leadId !== undefined) {
      return reply.send(await listOpportunitiesByLead(db, parsed.data.leadId));
    }
    const limit = parsed.data.limit ?? 200;
    try {
      const page = await listOpportunities(db, {
        limit,
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
      });
      return reply.send(page);
    } catch (err) {
      const mapped = mapOpportunityError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // GET /api/v1/opportunities/:id
  app.get('/api/v1/opportunities/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid opportunity id');
    try {
      return reply.send(await getOpportunity(db, params.data.id));
    } catch (err) {
      const mapped = mapOpportunityError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // POST /api/v1/opportunities
  app.post('/api/v1/opportunities', async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid opportunity', parsed.error.flatten());
    }
    const d = parsed.data;
    const input: CreateOpportunityInput = {
      leadId: d.leadId,
      ...(d.contactId !== undefined ? { contactId: d.contactId } : {}),
      ...(d.valueCents !== undefined ? { valueCents: d.valueCents } : {}),
      ...(d.currency !== undefined ? { currency: d.currency } : {}),
      ...(d.stageId !== undefined ? { stageId: d.stageId } : {}),
      ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
      ...(d.closeDate !== undefined ? { closeDate: d.closeDate } : {}),
      ...(d.ownerId !== undefined ? { ownerId: d.ownerId } : {}),
      ...(d.status !== undefined ? { status: d.status } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
      ...(d.actorId !== undefined ? { actorId: d.actorId } : {}),
    };
    try {
      const created = await createOpportunity(db, input);
      return reply.status(201).send(created);
    } catch (err) {
      const mapped = mapOpportunityError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // PATCH /api/v1/opportunities/:id
  app.patch('/api/v1/opportunities/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid opportunity id');
    const parsed = patchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid patch', parsed.error.flatten());
    }
    const d = parsed.data;
    const input: PatchOpportunityInput = {
      ...(d.valueCents !== undefined ? { valueCents: d.valueCents } : {}),
      ...(d.currency !== undefined ? { currency: d.currency } : {}),
      ...(d.stageId !== undefined ? { stageId: d.stageId } : {}),
      ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
      ...(d.closeDate !== undefined ? { closeDate: d.closeDate } : {}),
      ...(d.ownerId !== undefined ? { ownerId: d.ownerId } : {}),
      ...(d.status !== undefined ? { status: d.status } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
      ...(d.contactId !== undefined ? { contactId: d.contactId } : {}),
      ...(d.actorId !== undefined ? { actorId: d.actorId } : {}),
    };
    try {
      const updated = await patchOpportunity(db, params.data.id, input);
      return reply.send(updated);
    } catch (err) {
      const mapped = mapOpportunityError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // DELETE /api/v1/opportunities/:id
  app.delete('/api/v1/opportunities/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid opportunity id');
    try {
      await deleteOpportunity(db, params.data.id);
      return reply.status(204).send();
    } catch (err) {
      const mapped = mapOpportunityError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
