import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { contacts, leads, type Db } from '../../db/index.ts';
import { recordActivity } from '../activity/index.ts';
import type { Contact, EmailEntry, PhoneEntry } from '@switchboard/shared';

/**
 * Contacts engine service (CONTRACTS §C1/§C7). Real production read/write
 * surface behind `routes/contacts.ts`, replacing the DEV-ONLY read shim
 * (`dev/lead-detail.ts`) at real-API cutover.
 *
 * Contact create/update carry NO C4 event of their own — the taxonomy has no
 * `contact_*` type. The ONE exception is DNC: a contact's `dnc` toggle is a
 * compliance change, so it routes through the ActivityWriter and emits a
 * contact-scoped `dnc_set`/`dnc_cleared` on the parent lead's timeline (payload
 * `{scope:'contact', contactId}`) — never a raw column write that skips the
 * event.
 *
 * Import-safe for direct `node` execution: no enums / namespaces / parameter
 * properties (the host type-stripping constraint).
 */

// --- Errors ----------------------------------------------------------------

/**
 * A create referenced a `leadId` that is not a live lead. The route maps this to
 * `VALIDATION_FAILED` (§C8) — the bad id is in the request payload.
 */
export class InvalidContactLeadError extends Error {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`leadId ${leadId} does not reference a live lead`);
    this.name = 'InvalidContactLeadError';
    this.leadId = leadId;
  }
}

// --- DTO projection --------------------------------------------------------

/** MUST NOT select the generated `search_tsv` / `search_text` columns. */
const CONTACT_COLUMNS = {
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
} as const;

interface RawContactRow {
  id: string;
  leadId: string;
  name: string;
  title: string | null;
  emails: EmailEntry[];
  phones: PhoneEntry[];
  dnc: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toIso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
function toIsoRequired(value: string): string {
  return new Date(value).toISOString();
}

function mapContact(r: RawContactRow): Contact {
  return {
    id: r.id,
    leadId: r.leadId,
    name: r.name,
    title: r.title,
    emails: r.emails,
    phones: r.phones,
    dnc: r.dnc,
    deletedAt: toIso(r.deletedAt),
    createdAt: toIsoRequired(r.createdAt),
    updatedAt: toIsoRequired(r.updatedAt),
  };
}

// --- Reads -----------------------------------------------------------------

/**
 * GET /contacts?leadId= — a lead's contacts as a plain array (soft-deleted
 * excluded), oldest-first. Follows the WEB shape (plain array, not the keyset
 * envelope): per-lead contact sets are small and bounded (D-023/D-025).
 */
export async function listContactsByLead(db: Db, leadId: string): Promise<Contact[]> {
  const rows = (await db
    .select(CONTACT_COLUMNS)
    .from(contacts)
    .where(and(eq(contacts.leadId, leadId), isNull(contacts.deletedAt)))
    .orderBy(asc(contacts.createdAt))) as RawContactRow[];
  return rows.map(mapContact);
}

/** GET /contacts/:id — the full Contact DTO, or `null` when missing/deleted. */
export async function getContact(db: Db, id: string): Promise<Contact | null> {
  const rows = (await db
    .select(CONTACT_COLUMNS)
    .from(contacts)
    .where(and(eq(contacts.id, id), isNull(contacts.deletedAt)))
    .limit(1)) as RawContactRow[];
  const row = rows[0];
  return row === undefined ? null : mapContact(row);
}

// --- Create ----------------------------------------------------------------

export interface CreateContactInput {
  leadId: string;
  name: string;
  title?: string | null | undefined;
  emails?: EmailEntry[] | undefined;
  phones?: PhoneEntry[] | undefined;
  dnc?: boolean | undefined;
}

/** POST /contacts — insert under a live lead. No C4 event (no contact type). */
export async function createContact(db: Db, input: CreateContactInput): Promise<Contact> {
  const live = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, input.leadId), isNull(leads.deletedAt)))
    .limit(1);
  if (live[0] === undefined) throw new InvalidContactLeadError(input.leadId);

  const inserted = (await db
    .insert(contacts)
    .values({
      leadId: input.leadId,
      name: input.name,
      title: input.title ?? null,
      emails: input.emails ?? [],
      phones: input.phones ?? [],
      dnc: input.dnc ?? false,
    })
    .returning(CONTACT_COLUMNS)) as RawContactRow[];
  const row = inserted[0];
  if (row === undefined) throw new Error('contact insert returned no row');
  return mapContact(row);
}

// --- Update ----------------------------------------------------------------

export interface UpdateContactInput {
  name?: string | undefined;
  title?: string | null | undefined;
  emails?: EmailEntry[] | undefined;
  phones?: PhoneEntry[] | undefined;
  dnc?: boolean | undefined;
  /** Audit note carried on a DNC change (rides the event payload). */
  reason?: string | undefined;
}

export interface WriteActor {
  userId?: string | null;
}

function changed(before: unknown, after: unknown): boolean {
  if (before === after) return false;
  if (
    typeof before === 'object' &&
    before !== null &&
    typeof after === 'object' &&
    after !== null
  ) {
    return JSON.stringify(before) !== JSON.stringify(after);
  }
  return true;
}

/**
 * PATCH /contacts/:id — partial field mutation. Plain fields (name/title/
 * emails/phones) emit no event; a `dnc` change emits a contact-scoped
 * `dnc_set`/`dnc_cleared` through the ActivityWriter, atomically. Returns `null`
 * when the contact is missing/soft-deleted (route → 404).
 */
export async function updateContact(
  db: Db,
  id: string,
  input: UpdateContactInput,
  actor: WriteActor = {},
): Promise<Contact | null> {
  return db.transaction(async (tx) => {
    const currentRows = (await tx
      .select(CONTACT_COLUMNS)
      .from(contacts)
      .where(and(eq(contacts.id, id), isNull(contacts.deletedAt)))
      .limit(1)) as RawContactRow[];
    const current = currentRows[0];
    if (current === undefined) return null;

    const set: Record<string, unknown> = {};
    if (input.name !== undefined && changed(current.name, input.name)) set.name = input.name;
    if (input.title !== undefined && changed(current.title, input.title)) set.title = input.title;
    if (input.emails !== undefined && changed(current.emails, input.emails)) {
      set.emails = input.emails;
    }
    if (input.phones !== undefined && changed(current.phones, input.phones)) {
      set.phones = input.phones;
    }
    const dncChange =
      input.dnc !== undefined && changed(current.dnc, input.dnc)
        ? (input.dnc as boolean)
        : undefined;
    if (dncChange !== undefined) set.dnc = dncChange;

    if (Object.keys(set).length > 0) {
      set.updatedAt = sql`now()`;
      await tx.update(contacts).set(set).where(eq(contacts.id, id));
    }

    // DNC is the only contact change with a C4 event (compliance touch).
    if (dncChange !== undefined) {
      await recordActivity(tx, {
        leadId: current.leadId,
        contactId: id,
        userId: actor.userId ?? null,
        type: dncChange ? 'dnc_set' : 'dnc_cleared',
        occurredAt: new Date(),
        payload:
          input.reason !== undefined
            ? { scope: 'contact', contactId: id, reason: input.reason }
            : { scope: 'contact', contactId: id },
      });
    }

    const finalRows = (await tx
      .select(CONTACT_COLUMNS)
      .from(contacts)
      .where(eq(contacts.id, id))
      .limit(1)) as RawContactRow[];
    const finalRow = finalRows[0];
    return finalRow === undefined ? null : mapContact(finalRow);
  });
}

// --- Soft delete -----------------------------------------------------------

/**
 * DELETE /contacts/:id — soft delete (sets `deleted_at`). Returns `false` when
 * the contact is absent or already soft-deleted (route → 404).
 */
export async function softDeleteContact(db: Db, id: string): Promise<boolean> {
  const updated = await db
    .update(contacts)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(contacts.id, id), isNull(contacts.deletedAt)))
    .returning({ id: contacts.id });
  return updated.length > 0;
}
