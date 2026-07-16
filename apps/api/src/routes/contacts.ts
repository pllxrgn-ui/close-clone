import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emailEntrySchema, phoneEntrySchema } from '@switchboard/shared';

import type { Db } from '../db/index.ts';
import {
  InvalidContactLeadError,
  createContact,
  getContact,
  listContactsByLead,
  softDeleteContact,
  updateContact,
} from '../services/contacts/index.ts';
import { sendError } from './http.ts';

/**
 * Contacts CRUD routes (CONTRACTS §C7 `contacts`). A Fastify plugin factory —
 * the real production surface that replaces the DEV read shim
 * (`dev/lead-detail.ts`'s `GET /contacts`) at real-API cutover.
 *
 * `GET /contacts?leadId=` returns a PLAIN ARRAY (not the keyset envelope),
 * matching the web api-client (`features/leads/api/leadDetail.ts`) + MSW
 * (`leadHandlers.ts`) exactly — the shipping shape wins over C7's generic keyset
 * envelope for this per-lead read (D-023/D-025). Contact writes emit no C4 event
 * except DNC (contact-scoped `dnc_set`/`dnc_cleared` via the ActivityWriter).
 *
 * Import-safe for direct `node` execution: no enums / namespaces / parameter
 * properties (the host type-stripping constraint).
 */

export interface ContactRouteDeps {
  db: Db;
}

const listQuerySchema = z.object({ leadId: z.string().uuid() });

const createBodySchema = z.object({
  leadId: z.string().uuid(),
  name: z.string().min(1),
  title: z.string().nullable().optional(),
  emails: z.array(emailEntrySchema).optional(),
  phones: z.array(phoneEntrySchema).optional(),
  dnc: z.boolean().optional(),
});

const MUTATING_KEYS = ['name', 'title', 'emails', 'phones', 'dnc'] as const;
const patchBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    title: z.string().nullable().optional(),
    emails: z.array(emailEntrySchema).optional(),
    phones: z.array(phoneEntrySchema).optional(),
    dnc: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .refine((b) => MUTATING_KEYS.some((k) => b[k] !== undefined), {
    message: 'at least one field to update is required',
  });

export function registerContactRoutes(app: FastifyInstance, deps: ContactRouteDeps): void {
  const { db } = deps;

  // GET /api/v1/contacts?leadId= — a lead's contacts (plain array, live only).
  app.get('/api/v1/contacts', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'contacts requires ?leadId=<uuid>');
    }
    return reply.send(await listContactsByLead(db, parsed.data.leadId));
  });

  // POST /api/v1/contacts — create under a live lead.
  app.post('/api/v1/contacts', async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid contact body', parsed.error.flatten());
    }
    try {
      const contact = await createContact(db, parsed.data);
      return reply.status(201).send(contact);
    } catch (err) {
      if (err instanceof InvalidContactLeadError) {
        return sendError(reply, 'VALIDATION_FAILED', err.message, { field: 'leadId' });
      }
      throw err;
    }
  });

  // GET /api/v1/contacts/:id — full Contact DTO or 404.
  app.get<{ Params: { id: string } }>('/api/v1/contacts/:id', async (request, reply) => {
    const contact = await getContact(db, request.params.id);
    if (contact === null) return sendError(reply, 'NOT_FOUND', 'Contact not found');
    return reply.send(contact);
  });

  // PATCH /api/v1/contacts/:id — field mutation (DNC emits a C4 event).
  app.patch<{ Params: { id: string } }>('/api/v1/contacts/:id', async (request, reply) => {
    const parsed = patchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid contact patch', parsed.error.flatten());
    }
    const contact = await updateContact(db, request.params.id, parsed.data);
    if (contact === null) return sendError(reply, 'NOT_FOUND', 'Contact not found');
    return reply.send(contact);
  });

  // DELETE /api/v1/contacts/:id — soft delete (204) or 404.
  app.delete<{ Params: { id: string } }>('/api/v1/contacts/:id', async (request, reply) => {
    const ok = await softDeleteContact(db, request.params.id);
    if (!ok) return sendError(reply, 'NOT_FOUND', 'Contact not found');
    return reply.status(204).send();
  });
}
