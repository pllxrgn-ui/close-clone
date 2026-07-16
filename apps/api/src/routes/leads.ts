import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import {
  InvalidLeadReferenceError,
  MAX_LIMIT,
  createLead,
  decodeLeadCursor,
  getLead,
  getLeadTimeline,
  listLeads,
  softDeleteLead,
  updateLead,
  type ListLeadsParams,
  type TimelineParams,
} from '../services/leads/index.ts';
import { MergeLeadNotFoundError, SameLeadError, mergeLeads } from '../cli/merge.ts';
import { sendError } from './http.ts';

/**
 * Leads CRUD routes (CONTRACTS §C7 `leads` + `GET /leads/:id/timeline` +
 * `POST /leads/merge`). A Fastify plugin factory (`register*Routes(app, deps)`)
 * — the real production surface that replaces the DEV read shim (`dev/leads.ts`)
 * at real-API cutover, matching the web api-client + MSW shapes exactly so
 * flipping `VITE_API_MODE=real` needs zero web changes.
 *
 * Writes go through the leads engine service, which emits every C4 event via the
 * ActivityWriter (never a raw `activities` insert) and keeps the C1 denormalized
 * columns consistent in the same transaction. Merge reuses the 5g custody service
 * (`cli/merge.ts`) verbatim — no re-implementation.
 *
 * Import-safe for direct `node` execution: no enums / namespaces / parameter
 * properties (the host type-stripping constraint).
 */

export interface LeadRouteDeps {
  db: Db;
}

// --- Request DTOs (colocated; promote to shared at merge if needed) ---------

const listQuerySchema = z.object({
  statusId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  q: z.string().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const createBodySchema = z.object({
  name: z.string().min(1),
  url: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  statusId: z.string().uuid().nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  custom: z.record(z.unknown()).optional(),
  dnc: z.boolean().optional(),
});

/** At least one mutating field must be present (a bare `{reason}` is not a patch). */
const MUTATING_KEYS = [
  'name',
  'url',
  'description',
  'statusId',
  'ownerId',
  'custom',
  'dnc',
] as const;
const patchBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    statusId: z.string().uuid().nullable().optional(),
    ownerId: z.string().uuid().nullable().optional(),
    custom: z.record(z.unknown()).optional(),
    dnc: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .refine((b) => MUTATING_KEYS.some((k) => b[k] !== undefined), {
    message: 'at least one field to update is required',
  });

const mergeBodySchema = z.object({
  winnerId: z.string().uuid(),
  loserId: z.string().uuid(),
});

export function registerLeadRoutes(app: FastifyInstance, deps: LeadRouteDeps): void {
  const { db } = deps;

  // GET /api/v1/leads — keyset list (created desc), web filters statusId/ownerId.
  app.get('/api/v1/leads', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid leads query', parsed.error.flatten());
    }
    const { statusId, ownerId, q, cursor: cursorRaw, limit } = parsed.data;
    const params: ListLeadsParams = {};
    if (statusId !== undefined) params.statusId = statusId;
    if (ownerId !== undefined) params.ownerId = ownerId;
    if (q !== undefined) params.q = q;
    if (limit !== undefined) params.limit = limit;
    if (cursorRaw !== undefined) {
      const cursor = decodeLeadCursor(cursorRaw);
      if (cursor === null) return sendError(reply, 'VALIDATION_FAILED', 'invalid cursor');
      params.cursor = cursor;
    }
    return reply.send(await listLeads(db, params));
  });

  // POST /api/v1/leads — create + `lead_created` event.
  app.post('/api/v1/leads', async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid lead body', parsed.error.flatten());
    }
    try {
      const lead = await createLead(db, parsed.data);
      return reply.status(201).send(lead);
    } catch (err) {
      if (err instanceof InvalidLeadReferenceError) {
        return sendError(reply, 'VALIDATION_FAILED', err.message, { field: err.field });
      }
      throw err;
    }
  });

  // POST /api/v1/leads/merge — reuse the 5g custody service (static path wins
  // over `/leads/:id` in Fastify's radix tree; no GET/PATCH collision).
  app.post('/api/v1/leads/merge', async (request, reply) => {
    const parsed = mergeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid merge body', parsed.error.flatten());
    }
    try {
      const result = await mergeLeads(db, {
        winnerId: parsed.data.winnerId,
        loserId: parsed.data.loserId,
        actor: { actorType: 'system' },
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof SameLeadError) {
        return sendError(reply, 'VALIDATION_FAILED', err.message);
      }
      if (err instanceof MergeLeadNotFoundError) {
        return sendError(reply, 'NOT_FOUND', err.message);
      }
      throw err;
    }
  });

  // GET /api/v1/leads/:id — full Lead DTO or 404.
  app.get<{ Params: { id: string } }>('/api/v1/leads/:id', async (request, reply) => {
    const lead = await getLead(db, request.params.id);
    if (lead === null) return sendError(reply, 'NOT_FOUND', 'Lead not found');
    return reply.send(lead);
  });

  // GET /api/v1/leads/:id/timeline — newest-first Activity keyset page or 404.
  app.get<{ Params: { id: string } }>('/api/v1/leads/:id/timeline', async (request, reply) => {
    const parsed = pageQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid page query', parsed.error.flatten());
    }
    const params: TimelineParams = {};
    if (parsed.data.limit !== undefined) params.limit = parsed.data.limit;
    if (parsed.data.cursor !== undefined) {
      const cursor = decodeLeadCursor(parsed.data.cursor);
      if (cursor === null) return sendError(reply, 'VALIDATION_FAILED', 'invalid cursor');
      params.cursor = cursor;
    }
    const page = await getLeadTimeline(db, request.params.id, params);
    if (page === null) return sendError(reply, 'NOT_FOUND', 'Lead not found');
    return reply.send(page);
  });

  // PATCH /api/v1/leads/:id — field mutation + per-field C4 events.
  app.patch<{ Params: { id: string } }>('/api/v1/leads/:id', async (request, reply) => {
    const parsed = patchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid lead patch', parsed.error.flatten());
    }
    try {
      const lead = await updateLead(db, request.params.id, parsed.data);
      if (lead === null) return sendError(reply, 'NOT_FOUND', 'Lead not found');
      return reply.send(lead);
    } catch (err) {
      if (err instanceof InvalidLeadReferenceError) {
        return sendError(reply, 'VALIDATION_FAILED', err.message, { field: err.field });
      }
      throw err;
    }
  });

  // DELETE /api/v1/leads/:id — soft delete (204) or 404.
  app.delete<{ Params: { id: string } }>('/api/v1/leads/:id', async (request, reply) => {
    const ok = await softDeleteLead(db, request.params.id);
    if (!ok) return sendError(reply, 'NOT_FOUND', 'Lead not found');
    return reply.status(204).send();
  });
}
