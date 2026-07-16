import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { activities, leads, type Db } from '../db/index.ts';
import { sendError } from '../routes/http.ts';
import { decodeCursor, encodeCursor, toIso, toIsoRequired } from './util.ts';

/**
 * Leads read shims (DEV-ONLY). C7 lists `leads` as a CRUD resource, but no leads
 * route plugin exists on this branch — the web (W1) reads leads/list, lead/get,
 * and the lead timeline, so this provides exactly those three GETs against the
 * fixture, matching W1's MSW shapes: keyset `{items,nextCursor?}` (C7), the full
 * Lead DTO, and newest-first Activity pages. No writes — this is read-only glue.
 */

export interface LeadRouteDeps {
  db: Db;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Explicit Lead DTO projection — must NOT select the generated `search_tsv` /
// `search_text` columns, which are not part of the C7 Lead shape.
const LEAD_COLUMNS = {
  id: leads.id,
  name: leads.name,
  url: leads.url,
  description: leads.description,
  statusId: leads.statusId,
  ownerId: leads.ownerId,
  custom: leads.custom,
  lastContactedAt: leads.lastContactedAt,
  lastInboundAt: leads.lastInboundAt,
  nextTaskDueAt: leads.nextTaskDueAt,
  lastCallAt: leads.lastCallAt,
  lastEmailAt: leads.lastEmailAt,
  lastSmsAt: leads.lastSmsAt,
  dnc: leads.dnc,
  deletedAt: leads.deletedAt,
  createdAt: leads.createdAt,
  updatedAt: leads.updatedAt,
} as const;

interface RawLeadRow {
  id: string;
  name: string;
  url: string | null;
  description: string | null;
  statusId: string | null;
  ownerId: string | null;
  custom: Record<string, unknown>;
  lastContactedAt: string | null;
  lastInboundAt: string | null;
  nextTaskDueAt: string | null;
  lastCallAt: string | null;
  lastEmailAt: string | null;
  lastSmsAt: string | null;
  dnc: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Coerce a raw Drizzle lead row into the C7 Lead DTO (ISO timestamps). */
export function mapLead(r: RawLeadRow): RawLeadRow {
  return {
    ...r,
    lastContactedAt: toIso(r.lastContactedAt),
    lastInboundAt: toIso(r.lastInboundAt),
    nextTaskDueAt: toIso(r.nextTaskDueAt),
    lastCallAt: toIso(r.lastCallAt),
    lastEmailAt: toIso(r.lastEmailAt),
    lastSmsAt: toIso(r.lastSmsAt),
    deletedAt: toIso(r.deletedAt),
    createdAt: toIsoRequired(r.createdAt),
    updatedAt: toIsoRequired(r.updatedAt),
  };
}

export { LEAD_COLUMNS };

const listQuerySchema = z.object({
  statusId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

export function registerDevLeadRoutes(app: FastifyInstance, deps: LeadRouteDeps): void {
  // GET /api/v1/leads?statusId=&ownerId=&cursor=&limit= — keyset (created desc).
  app.get('/api/v1/leads', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid leads query', parsed.error.flatten());
    }
    const { statusId, ownerId, cursor: cursorRaw, limit: limitRaw } = parsed.data;
    const limit = limitRaw ?? DEFAULT_LIMIT;

    const conds: SQL[] = [isNull(leads.deletedAt)];
    if (statusId !== undefined) conds.push(eq(leads.statusId, statusId));
    if (ownerId !== undefined) conds.push(eq(leads.ownerId, ownerId));
    if (cursorRaw !== undefined) {
      const cursor = decodeCursor(cursorRaw);
      if (cursor === null || typeof cursor.v !== 'string') {
        return sendError(reply, 'VALIDATION_FAILED', 'invalid cursor');
      }
      conds.push(
        sql`(${leads.createdAt}, ${leads.id}) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const rows = (await deps.db
      .select(LEAD_COLUMNS)
      .from(leads)
      .where(and(...conds))
      .orderBy(desc(leads.createdAt), desc(leads.id))
      .limit(limit + 1)) as RawLeadRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapLead);
    const last = pageRows[pageRows.length - 1];
    if (hasMore && last !== undefined) {
      return { items, nextCursor: encodeCursor({ v: last.createdAt, id: last.id }) };
    }
    return { items };
  });

  // GET /api/v1/leads/:id — the full Lead DTO, or 404.
  app.get<{ Params: { id: string } }>('/api/v1/leads/:id', async (request, reply) => {
    const rows = (await deps.db
      .select(LEAD_COLUMNS)
      .from(leads)
      .where(and(eq(leads.id, request.params.id), isNull(leads.deletedAt)))
      .limit(1)) as RawLeadRow[];
    const row = rows[0];
    if (row === undefined) return sendError(reply, 'NOT_FOUND', 'Lead not found');
    return mapLead(row);
  });

  // GET /api/v1/leads/:id/timeline?cursor=&limit= — Activity page, newest first.
  app.get<{ Params: { id: string } }>('/api/v1/leads/:id/timeline', async (request, reply) => {
    const parsed = pageQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid page query', parsed.error.flatten());
    }
    const leadId = request.params.id;
    const exists = await deps.db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
      .limit(1);
    if (exists[0] === undefined) return sendError(reply, 'NOT_FOUND', 'Lead not found');

    const limit = parsed.data.limit ?? DEFAULT_LIMIT;
    const conds: SQL[] = [eq(activities.leadId, leadId)];
    if (parsed.data.cursor !== undefined) {
      const cursor = decodeCursor(parsed.data.cursor);
      if (cursor === null || typeof cursor.v !== 'string') {
        return sendError(reply, 'VALIDATION_FAILED', 'invalid cursor');
      }
      conds.push(
        sql`(${activities.occurredAt}, ${activities.id}) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const rows = await deps.db
      .select({
        id: activities.id,
        leadId: activities.leadId,
        contactId: activities.contactId,
        userId: activities.userId,
        type: activities.type,
        occurredAt: activities.occurredAt,
        payload: activities.payload,
        createdAt: activities.createdAt,
        updatedAt: activities.updatedAt,
      })
      .from(activities)
      .where(and(...conds))
      .orderBy(desc(activities.occurredAt), desc(activities.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((r) => ({
      ...r,
      occurredAt: toIsoRequired(r.occurredAt),
      createdAt: toIsoRequired(r.createdAt),
      updatedAt: toIsoRequired(r.updatedAt),
    }));
    const last = pageRows[pageRows.length - 1];
    if (hasMore && last !== undefined) {
      return { items, nextCursor: encodeCursor({ v: last.occurredAt, id: last.id }) };
    }
    return { items };
  });
}
