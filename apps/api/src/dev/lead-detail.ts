import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { contacts, opportunities, type Db } from '../db/index.ts';
import { sendError } from '../routes/http.ts';
import { toIso, toIsoRequired } from './util.ts';

/**
 * Lead-detail read shims (DEV-ONLY, mirroring `leads.ts`). The web's lead page
 * right rail reads `GET /contacts?leadId=` and `GET /opportunities?leadId=` as
 * plain arrays (small, per-lead bounded sets — the reference-data style, not the
 * keyset envelope). No route plugin owns these C7 resources yet, so the dev
 * server provides read-only projections against the fixture. Found by the
 * real-click rehearsal: without these the right rail renders its error states.
 */

export interface LeadDetailRouteDeps {
  db: Db;
}

const querySchema = z.object({ leadId: z.string().uuid() });

export function registerDevLeadDetailRoutes(app: FastifyInstance, deps: LeadDetailRouteDeps): void {
  const { db } = deps;

  app.get('/api/v1/contacts', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'contacts requires ?leadId=<uuid>');
    }
    const rows = await db
      .select({
        id: contacts.id,
        leadId: contacts.leadId,
        name: contacts.name,
        title: contacts.title,
        emails: contacts.emails,
        phones: contacts.phones,
        dnc: contacts.dnc,
        deletedAt: contacts.deletedAt,
        createdAt: contacts.createdAt,
        updatedAt: contacts.updatedAt,
      })
      .from(contacts)
      .where(and(eq(contacts.leadId, parsed.data.leadId), isNull(contacts.deletedAt)))
      .orderBy(asc(contacts.createdAt));
    return reply.send(
      rows.map((r) => ({
        ...r,
        deletedAt: toIso(r.deletedAt),
        createdAt: toIsoRequired(r.createdAt),
        updatedAt: toIsoRequired(r.updatedAt),
      })),
    );
  });

  app.get('/api/v1/opportunities', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'opportunities requires ?leadId=<uuid>');
    }
    const rows = await db
      .select({
        id: opportunities.id,
        leadId: opportunities.leadId,
        contactId: opportunities.contactId,
        valueCents: opportunities.valueCents,
        currency: opportunities.currency,
        stageId: opportunities.stageId,
        confidence: opportunities.confidence,
        closeDate: opportunities.closeDate,
        ownerId: opportunities.ownerId,
        status: opportunities.status,
        note: opportunities.note,
        createdAt: opportunities.createdAt,
        updatedAt: opportunities.updatedAt,
      })
      .from(opportunities)
      .where(eq(opportunities.leadId, parsed.data.leadId))
      .orderBy(asc(opportunities.createdAt));
    return reply.send(
      rows.map((r) => ({
        ...r,
        valueCents: typeof r.valueCents === 'bigint' ? Number(r.valueCents) : r.valueCents,
        createdAt: toIsoRequired(r.createdAt),
        updatedAt: toIsoRequired(r.updatedAt),
      })),
    );
  });
}
