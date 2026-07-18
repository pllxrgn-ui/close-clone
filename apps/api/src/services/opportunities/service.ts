import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { Opportunity } from '@switchboard/shared';
import {
  contacts,
  leads,
  opportunities,
  opportunityStages,
  users,
  type Db,
} from '../../db/index.ts';
import { recordActivity, type ActivityWebhookEmitter } from '../activity/index.ts';

/**
 * Opportunities CRUD service (CONTRACTS §C7 `opportunities`, §C1 schema, §C4
 * events). This is the real-API realization of the resource the web currently
 * drives through MSW — the pipeline board (`GET /opportunities` keyset envelope +
 * `PATCH /opportunities/:id` stage/won-lost) and the lead-detail right rail
 * (`GET /opportunities?leadId=` plain array). See CONTRACTS §C7 v1.3.1 note.
 *
 * Every write that changes a record emits its C4 event through the ActivityWriter
 * (`recordActivity`) IN THE SAME TRANSACTION, so the append to the spine and the
 * denormalized `leads` columns commit atomically with the record change:
 *   - POST                         → `opportunity_created`
 *   - PATCH that changes the stage → `opportunity_stage_changed` (payload `from`/`to`
 *     are STAGE IDs, per D-017 friction — pinned by CONTRACTS §C4's event payload
 *     schema and the reports fixtures)
 *   - PATCH status → won|lost      → `opportunity_closed`
 * DELETE has no C4 event (there is no `opportunity_deleted` type) and no denorm
 * impact (opportunity events touch no last-touch column).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

type OpportunityRow = typeof opportunities.$inferSelect;
type OpportunityStatus = Opportunity['status'];

// --- Errors ----------------------------------------------------------------

export class OpportunityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpportunityError';
  }
}

/** The opportunity id does not exist. Maps to NOT_FOUND (§C8). */
export class OpportunityNotFoundError extends OpportunityError {
  readonly opportunityId: string;
  constructor(opportunityId: string) {
    super(`opportunity ${opportunityId} not found`);
    this.name = 'OpportunityNotFoundError';
    this.opportunityId = opportunityId;
  }
}

/** The target lead is missing or soft-deleted. Maps to NOT_FOUND (§C8). */
export class OpportunityLeadNotFoundError extends OpportunityError {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`lead ${leadId} not found or soft-deleted`);
    this.name = 'OpportunityLeadNotFoundError';
    this.leadId = leadId;
  }
}

/** A referenced FK (stageId/contactId/ownerId) does not exist. Maps to VALIDATION_FAILED. */
export class InvalidReferenceError extends OpportunityError {
  readonly field: string;
  readonly value: string;
  constructor(field: string, value: string) {
    super(`invalid ${field}: ${value} does not exist`);
    this.name = 'InvalidReferenceError';
    this.field = field;
    this.value = value;
  }
}

/** A malformed keyset cursor. Maps to VALIDATION_FAILED (§C8). */
export class InvalidOpportunityCursorError extends OpportunityError {
  constructor(cursor: string) {
    super(`invalid cursor: ${cursor}`);
    this.name = 'InvalidOpportunityCursorError';
  }
}

// --- Serialization (DB row → §C7 DTO) --------------------------------------

/**
 * Drizzle reads `timestamptz` (mode:'string') back in Postgres text form
 * (`2026-07-10 12:34:56+00`); the web speaks ISO-8601 (`…T…Z`). Normalise so date
 * parsing on the web is identical to mock mode (mirrors `dev/util.toIso`). `date`
 * columns already read back as `YYYY-MM-DD`, so `closeDate` passes through.
 */
function toIsoRequired(value: string): string {
  return new Date(value).toISOString();
}

export function serializeOpportunity(row: OpportunityRow): Opportunity {
  return {
    id: row.id,
    leadId: row.leadId,
    contactId: row.contactId,
    valueCents: Number(row.valueCents),
    currency: row.currency,
    stageId: row.stageId,
    confidence: row.confidence,
    closeDate: row.closeDate,
    ownerId: row.ownerId,
    status: row.status,
    note: row.note,
    createdAt: toIsoRequired(row.createdAt),
    updatedAt: toIsoRequired(row.updatedAt),
  };
}

// --- Keyset cursor (opaque; C7 cursors are opaque base64url) ----------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): string {
  const id = Buffer.from(raw, 'base64url').toString('utf8');
  if (!UUID_RE.test(id)) throw new InvalidOpportunityCursorError(raw);
  return id;
}

// --- Existence checks (clean C8 errors instead of raw FK 500s) --------------

async function leadExists(db: Db, leadId: string): Promise<boolean> {
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
    .limit(1);
  return rows[0] !== undefined;
}

async function stageExists(db: Db, stageId: string): Promise<boolean> {
  const rows = await db
    .select({ id: opportunityStages.id })
    .from(opportunityStages)
    .where(eq(opportunityStages.id, stageId))
    .limit(1);
  return rows[0] !== undefined;
}

async function contactExists(db: Db, contactId: string): Promise<boolean> {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return rows[0] !== undefined;
}

async function userExists(db: Db, userId: string): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] !== undefined;
}

// --- Reads -----------------------------------------------------------------

export interface ListOpportunitiesOptions {
  limit: number;
  cursor?: string;
}

export interface OpportunityPage {
  items: Opportunity[];
  nextCursor?: string;
}

/**
 * The pipeline board read: EVERY opportunity (open + closed, all leads), keyset-
 * paginated over the stable id order (§C7 `{ items, nextCursor? }`). No `leadId`
 * filter — the board sums column/pipeline totals across the whole set.
 */
export async function listOpportunities(
  db: Db,
  opts: ListOpportunitiesOptions,
): Promise<OpportunityPage> {
  const afterId = opts.cursor !== undefined ? decodeCursor(opts.cursor) : undefined;
  const rows = await db
    .select()
    .from(opportunities)
    .where(afterId !== undefined ? gt(opportunities.id, afterId) : undefined)
    .orderBy(asc(opportunities.id))
    .limit(opts.limit + 1);

  const items = rows.slice(0, opts.limit).map(serializeOpportunity);
  const overflow = rows[opts.limit];
  if (overflow !== undefined) {
    const last = rows[opts.limit - 1];
    if (last !== undefined) return { items, nextCursor: encodeCursor(last.id) };
  }
  return { items };
}

/**
 * The lead-detail right rail read: a single lead's opportunities as a plain
 * array (small bounded set — the reference-data style the web established for
 * per-lead reads, not the keyset envelope).
 */
export async function listOpportunitiesByLead(db: Db, leadId: string): Promise<Opportunity[]> {
  const rows = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.leadId, leadId))
    .orderBy(asc(opportunities.createdAt), asc(opportunities.id));
  return rows.map(serializeOpportunity);
}

export async function getOpportunity(db: Db, id: string): Promise<Opportunity> {
  const rows = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new OpportunityNotFoundError(id);
  return serializeOpportunity(row);
}

// --- Create ----------------------------------------------------------------

export interface CreateOpportunityInput {
  leadId: string;
  contactId?: string | null;
  valueCents?: number;
  currency?: string;
  stageId?: string | null;
  confidence?: number;
  closeDate?: string | null;
  ownerId?: string | null;
  status?: OpportunityStatus;
  note?: string | null;
  /** Acting user recorded as the event's `user_id` (§C4). */
  actorId?: string | null;
}

export async function createOpportunity(
  db: Db,
  input: CreateOpportunityInput,
  emitter?: ActivityWebhookEmitter,
): Promise<Opportunity> {
  if (!(await leadExists(db, input.leadId))) throw new OpportunityLeadNotFoundError(input.leadId);
  if (input.stageId != null && !(await stageExists(db, input.stageId))) {
    throw new InvalidReferenceError('stageId', input.stageId);
  }
  if (input.contactId != null && !(await contactExists(db, input.contactId))) {
    throw new InvalidReferenceError('contactId', input.contactId);
  }
  if (input.ownerId != null && !(await userExists(db, input.ownerId))) {
    throw new InvalidReferenceError('ownerId', input.ownerId);
  }

  const nowIso = new Date().toISOString();
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const inserted = await tx
      .insert(opportunities)
      .values({
        leadId: input.leadId,
        contactId: input.contactId ?? null,
        valueCents: input.valueCents ?? 0,
        currency: input.currency ?? 'USD',
        stageId: input.stageId ?? null,
        confidence: input.confidence ?? 0,
        closeDate: input.closeDate ?? null,
        ownerId: input.ownerId ?? null,
        status: input.status ?? 'active',
        note: input.note ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new OpportunityError('opportunity insert returned no row');

    await recordActivity(
      tx,
      {
        leadId: row.leadId,
        userId: input.actorId ?? input.ownerId ?? null,
        type: 'opportunity_created',
        occurredAt: nowIso,
        payload: { opportunityId: row.id, valueCents: Number(row.valueCents) },
      },
      emitter,
    );

    return serializeOpportunity(row);
  });
}

// --- Patch (value / stage / confidence / close / status / …) ----------------

export interface PatchOpportunityInput {
  valueCents?: number;
  currency?: string;
  stageId?: string | null;
  confidence?: number;
  closeDate?: string | null;
  ownerId?: string | null;
  status?: OpportunityStatus;
  note?: string | null;
  contactId?: string | null;
  /** Acting user recorded as the event's `user_id` (§C4). */
  actorId?: string | null;
}

const CLOSED_STATUSES: ReadonlySet<OpportunityStatus> = new Set<OpportunityStatus>(['won', 'lost']);

export async function patchOpportunity(
  db: Db,
  id: string,
  input: PatchOpportunityInput,
  emitter?: ActivityWebhookEmitter,
): Promise<Opportunity> {
  if (input.stageId != null && !(await stageExists(db, input.stageId))) {
    throw new InvalidReferenceError('stageId', input.stageId);
  }
  if (input.contactId != null && !(await contactExists(db, input.contactId))) {
    throw new InvalidReferenceError('contactId', input.contactId);
  }
  if (input.ownerId != null && !(await userExists(db, input.ownerId))) {
    throw new InvalidReferenceError('ownerId', input.ownerId);
  }

  const nowIso = new Date().toISOString();
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    // Lock the row so a concurrent PATCH cannot lose the from→to event basis.
    const currentRows = await tx
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, id))
      .limit(1)
      .for('update');
    const current = currentRows[0];
    if (current === undefined) throw new OpportunityNotFoundError(id);

    const set = {
      updatedAt: nowIso,
      ...(input.valueCents !== undefined ? { valueCents: input.valueCents } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.closeDate !== undefined ? { closeDate: input.closeDate } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
    };
    const updatedRows = await tx
      .update(opportunities)
      .set(set)
      .where(eq(opportunities.id, id))
      .returning();
    const updated = updatedRows[0];
    if (updated === undefined) throw new OpportunityNotFoundError(id);

    // Stage move → opportunity_stage_changed (from/to are STAGE IDs, D-017).
    if (input.stageId !== undefined && updated.stageId !== current.stageId) {
      await recordActivity(
        tx,
        {
          leadId: updated.leadId,
          userId: input.actorId ?? null,
          type: 'opportunity_stage_changed',
          occurredAt: nowIso,
          payload: { opportunityId: id, from: current.stageId, to: updated.stageId },
        },
        emitter,
      );
    }
    // Transition into won/lost → opportunity_closed.
    if (
      input.status !== undefined &&
      CLOSED_STATUSES.has(updated.status) &&
      updated.status !== current.status
    ) {
      await recordActivity(
        tx,
        {
          leadId: updated.leadId,
          userId: input.actorId ?? null,
          type: 'opportunity_closed',
          occurredAt: nowIso,
          payload: {
            opportunityId: id,
            status: updated.status,
            valueCents: Number(updated.valueCents),
          },
        },
        emitter,
      );
    }

    return serializeOpportunity(updated);
  });
}

// --- Delete ----------------------------------------------------------------

export async function deleteOpportunity(db: Db, id: string): Promise<void> {
  const deleted = await db
    .delete(opportunities)
    .where(eq(opportunities.id, id))
    .returning({ id: opportunities.id });
  if (deleted.length === 0) throw new OpportunityNotFoundError(id);
}
