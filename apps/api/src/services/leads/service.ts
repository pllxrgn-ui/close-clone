import { and, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { activities, leads, leadStatuses, users, type Db } from '../../db/index.ts';
import { recordActivity, type ActivityWebhookEmitter } from '../activity/index.ts';
import type { Activity, Lead } from '@switchboard/shared';

/**
 * Leads engine service (CONTRACTS §C1/§C4/§C7). The real production read/write
 * surface behind `routes/leads.ts`, replacing the DEV-ONLY read shim
 * (`dev/leads.ts`) at real-API cutover. Every write that changes a record emits
 * the correct C4 event through the ActivityWriter (`recordActivity`) — never a
 * raw `activities` insert — in the SAME transaction as the column change, so the
 * append-only spine and the C1 denormalized `leads` hot columns stay consistent.
 *
 * The DTO projection is byte-identical to the dev shim's (and thus to the web's
 * MSW `Lead` shape): the generated `search_tsv` / `search_text` columns are never
 * selected, and every timestamp is normalised to ISO-8601 (`T`/`Z`) so real-mode
 * output parses identically to mock mode.
 *
 * Import-safe for direct `node` execution: no enums / namespaces / parameter
 * properties (the host type-stripping constraint).
 */

// --- Errors ----------------------------------------------------------------

/**
 * A create/update referenced a status or owner that does not exist. The route
 * maps this to `VALIDATION_FAILED` (§C8) — the bad id is in the request payload,
 * not a missing resource in the path.
 */
export class InvalidLeadReferenceError extends Error {
  readonly field: string;
  constructor(field: string, id: string) {
    super(
      `${field} ${id} does not reference an existing ${field === 'statusId' ? 'lead status' : 'user'}`,
    );
    this.name = 'InvalidLeadReferenceError';
    this.field = field;
  }
}

// --- DTO projection --------------------------------------------------------

/**
 * Explicit Lead DTO projection (CONTRACTS §C7). MUST NOT select the generated
 * `search_tsv` / `search_text` columns — they are persistence-only, not part of
 * the Lead shape.
 */
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

/** Drizzle reads `timestamptz` as Postgres text; the web speaks ISO-8601. */
function toIso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
function toIsoRequired(value: string): string {
  return new Date(value).toISOString();
}

/**
 * Guard a path-param id before it reaches a `uuid` column comparison — a
 * non-uuid would make Postgres throw (500). A malformed id can name no lead, so
 * by-id reads/writes treat it as "not found" (404 at the route).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** Coerce a raw Drizzle lead row into the C7 Lead DTO (ISO timestamps). */
function mapLead(r: RawLeadRow): Lead {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    description: r.description,
    statusId: r.statusId,
    ownerId: r.ownerId,
    custom: r.custom,
    lastContactedAt: toIso(r.lastContactedAt),
    lastInboundAt: toIso(r.lastInboundAt),
    nextTaskDueAt: toIso(r.nextTaskDueAt),
    lastCallAt: toIso(r.lastCallAt),
    lastEmailAt: toIso(r.lastEmailAt),
    lastSmsAt: toIso(r.lastSmsAt),
    dnc: r.dnc,
    deletedAt: toIso(r.deletedAt),
    createdAt: toIsoRequired(r.createdAt),
    updatedAt: toIsoRequired(r.updatedAt),
  };
}

// --- Opaque keyset cursor --------------------------------------------------

interface CursorParts {
  v: string;
  id: string;
}
function encodeCursor(parts: CursorParts): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}
/** Decode a cursor token; `null` when malformed (caller maps that to 400). */
export function decodeLeadCursor(raw: string): CursorParts | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { id?: unknown }).id !== 'string' ||
      typeof (parsed as { v?: unknown }).v !== 'string'
    ) {
      return null;
    }
    const { v, id } = parsed as { v: string; id: string };
    return { v, id };
  } catch {
    return null;
  }
}

// --- Page envelope ---------------------------------------------------------

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface ListLeadsParams {
  statusId?: string;
  ownerId?: string;
  /** Optional case-insensitive substring filter on name. */
  q?: string;
  /** Batch id filter (≤ MAX_LIMIT ids) — label/name resolution without draining. */
  ids?: string[];
  cursor?: CursorParts;
  limit?: number;
}

/** GET /leads — keyset list over live leads, newest-created first. */
export async function listLeads(db: Db, params: ListLeadsParams): Promise<Page<Lead>> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const conds: SQL[] = [isNull(leads.deletedAt)];
  if (params.statusId !== undefined) conds.push(eq(leads.statusId, params.statusId));
  if (params.ownerId !== undefined) conds.push(eq(leads.ownerId, params.ownerId));
  if (params.q !== undefined && params.q.length > 0) {
    conds.push(ilike(leads.name, `%${params.q}%`));
  }
  if (params.ids !== undefined && params.ids.length > 0) {
    conds.push(inArray(leads.id, params.ids));
  }
  if (params.cursor !== undefined) {
    conds.push(
      sql`(${leads.createdAt}, ${leads.id}) < (${params.cursor.v}::timestamptz, ${params.cursor.id}::uuid)`,
    );
  }

  const rows = (await db
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
}

/** GET /leads/:id — the full Lead DTO, or `null` when missing/soft-deleted. */
export async function getLead(db: Db, id: string): Promise<Lead | null> {
  if (!isUuid(id)) return null;
  const rows = (await db
    .select(LEAD_COLUMNS)
    .from(leads)
    .where(and(eq(leads.id, id), isNull(leads.deletedAt)))
    .limit(1)) as RawLeadRow[];
  const row = rows[0];
  return row === undefined ? null : mapLead(row);
}

// --- Timeline --------------------------------------------------------------

interface RawActivityRow {
  id: string;
  leadId: string;
  contactId: string | null;
  userId: string | null;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineParams {
  cursor?: CursorParts;
  limit?: number;
}

/**
 * GET /leads/:id/timeline — newest-first keyset page of C4 activity events
 * (ordering key `(occurred_at, id)`). Returns `null` when the lead is
 * missing/soft-deleted (route → 404).
 */
export async function getLeadTimeline(
  db: Db,
  leadId: string,
  params: TimelineParams,
): Promise<Page<Activity> | null> {
  if (!isUuid(leadId)) return null;
  const exists = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
    .limit(1);
  if (exists[0] === undefined) return null;

  const limit = params.limit ?? DEFAULT_LIMIT;
  const conds: SQL[] = [eq(activities.leadId, leadId)];
  if (params.cursor !== undefined) {
    conds.push(
      sql`(${activities.occurredAt}, ${activities.id}) < (${params.cursor.v}::timestamptz, ${params.cursor.id}::uuid)`,
    );
  }

  const rows = (await db
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
    .limit(limit + 1)) as RawActivityRow[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items: Activity[] = pageRows.map((r) => ({
    id: r.id,
    leadId: r.leadId,
    contactId: r.contactId,
    userId: r.userId,
    type: r.type,
    occurredAt: toIsoRequired(r.occurredAt),
    payload: r.payload,
    createdAt: toIsoRequired(r.createdAt),
    updatedAt: toIsoRequired(r.updatedAt),
  }));
  const last = pageRows[pageRows.length - 1];
  if (hasMore && last !== undefined) {
    return { items, nextCursor: encodeCursor({ v: last.occurredAt, id: last.id }) };
  }
  return { items };
}

// --- Reference validation --------------------------------------------------

async function assertReferences(
  db: Db,
  refs: { statusId?: string | null | undefined; ownerId?: string | null | undefined },
): Promise<void> {
  if (refs.statusId !== undefined && refs.statusId !== null) {
    const s = await db
      .select({ id: leadStatuses.id })
      .from(leadStatuses)
      .where(eq(leadStatuses.id, refs.statusId))
      .limit(1);
    if (s[0] === undefined) throw new InvalidLeadReferenceError('statusId', refs.statusId);
  }
  if (refs.ownerId !== undefined && refs.ownerId !== null) {
    const u = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, refs.ownerId))
      .limit(1);
    if (u[0] === undefined) throw new InvalidLeadReferenceError('ownerId', refs.ownerId);
  }
}

// --- Create ----------------------------------------------------------------

export interface CreateLeadInput {
  name: string;
  url?: string | null | undefined;
  description?: string | null | undefined;
  statusId?: string | null | undefined;
  ownerId?: string | null | undefined;
  custom?: Record<string, unknown> | undefined;
  dnc?: boolean | undefined;
}

export interface WriteActor {
  userId?: string | null;
}

/** POST /leads — insert + `lead_created` event, atomically. */
export async function createLead(
  db: Db,
  input: CreateLeadInput,
  actor: WriteActor = {},
  emitter?: ActivityWebhookEmitter,
): Promise<Lead> {
  return db.transaction(async (tx) => {
    await assertReferences(tx, { statusId: input.statusId, ownerId: input.ownerId });
    const inserted = (await tx
      .insert(leads)
      .values({
        name: input.name,
        url: input.url ?? null,
        description: input.description ?? null,
        statusId: input.statusId ?? null,
        ownerId: input.ownerId ?? null,
        custom: input.custom ?? {},
        dnc: input.dnc ?? false,
      })
      .returning(LEAD_COLUMNS)) as RawLeadRow[];
    const row = inserted[0];
    if (row === undefined) throw new Error('lead insert returned no row');

    await recordActivity(
      tx,
      {
        leadId: row.id,
        userId: actor.userId ?? null,
        type: 'lead_created',
        occurredAt: new Date(),
        payload: {},
      },
      emitter,
    );

    // Re-read so the DTO reflects the writer's `updated_at` bump.
    const finalRow = await getLead(tx, row.id);
    if (finalRow === null) throw new Error('created lead vanished');
    return finalRow;
  });
}

// --- Update ----------------------------------------------------------------

export interface UpdateLeadInput {
  name?: string | undefined;
  url?: string | null | undefined;
  description?: string | null | undefined;
  statusId?: string | null | undefined;
  ownerId?: string | null | undefined;
  custom?: Record<string, unknown> | undefined;
  dnc?: boolean | undefined;
  /** Audit note carried on a DNC change (rides the event payload). */
  reason?: string | undefined;
}

/** Fields whose change emits a generic `field_changed` event. */
const FIELD_CHANGED_KEYS = ['name', 'url', 'description', 'ownerId', 'custom'] as const;
type FieldChangedKey = (typeof FIELD_CHANGED_KEYS)[number];

function changed(before: unknown, after: unknown): boolean {
  if (before === after) return false;
  // `custom` is an object — compare structurally.
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
 * PATCH /leads/:id — apply a partial field mutation and emit exactly one C4
 * event per changed tracked field (`field_changed`, `status_changed`,
 * `dnc_set`/`dnc_cleared`) via the ActivityWriter, atomically. Returns `null`
 * when the lead is missing/soft-deleted (route → 404). DNC set/clear routes
 * through this engine path — never a raw column write that skips the event.
 */
export async function updateLead(
  db: Db,
  id: string,
  input: UpdateLeadInput,
  actor: WriteActor = {},
  emitter?: ActivityWebhookEmitter,
): Promise<Lead | null> {
  if (!isUuid(id)) return null;
  return db.transaction(async (tx) => {
    const currentRows = (await tx
      .select(LEAD_COLUMNS)
      .from(leads)
      .where(and(eq(leads.id, id), isNull(leads.deletedAt)))
      .limit(1)) as RawLeadRow[];
    const current = currentRows[0];
    if (current === undefined) return null;

    await assertReferences(tx, { statusId: input.statusId, ownerId: input.ownerId });

    const set: Record<string, unknown> = {};
    if (input.name !== undefined && changed(current.name, input.name)) set.name = input.name;
    if (input.url !== undefined && changed(current.url, input.url)) set.url = input.url;
    if (input.description !== undefined && changed(current.description, input.description)) {
      set.description = input.description;
    }
    if (input.ownerId !== undefined && changed(current.ownerId, input.ownerId)) {
      set.ownerId = input.ownerId;
    }
    if (input.custom !== undefined && changed(current.custom, input.custom)) {
      set.custom = input.custom;
    }
    if (input.statusId !== undefined && changed(current.statusId, input.statusId)) {
      set.statusId = input.statusId;
    }
    const dncChange =
      input.dnc !== undefined && changed(current.dnc, input.dnc)
        ? (input.dnc as boolean)
        : undefined;
    if (dncChange !== undefined) set.dnc = dncChange;

    if (Object.keys(set).length > 0) {
      set.updatedAt = sql`now()`;
      await tx.update(leads).set(set).where(eq(leads.id, id));
    }

    const occurredAt = new Date();

    // field_changed — one per changed plain field.
    for (const key of FIELD_CHANGED_KEYS) {
      const beforeVal = current[key as keyof RawLeadRow] as unknown;
      const afterVal = input[key as FieldChangedKey];
      if (afterVal !== undefined && changed(beforeVal, afterVal)) {
        await recordActivity(
          tx,
          {
            leadId: id,
            userId: actor.userId ?? null,
            type: 'field_changed',
            occurredAt,
            payload: { field: key, before: beforeVal ?? null, after: afterVal },
          },
          emitter,
        );
      }
    }

    // status_changed.
    if (input.statusId !== undefined && changed(current.statusId, input.statusId)) {
      await recordActivity(
        tx,
        {
          leadId: id,
          userId: actor.userId ?? null,
          type: 'status_changed',
          occurredAt,
          payload: {
            from: current.statusId,
            to: input.statusId,
            statusId: input.statusId ?? undefined,
          },
        },
        emitter,
      );
    }

    // dnc_set / dnc_cleared.
    if (dncChange !== undefined) {
      await recordActivity(
        tx,
        {
          leadId: id,
          userId: actor.userId ?? null,
          type: dncChange ? 'dnc_set' : 'dnc_cleared',
          occurredAt,
          payload:
            input.reason !== undefined
              ? { scope: 'lead', reason: input.reason }
              : { scope: 'lead' },
        },
        emitter,
      );
    }

    const finalRow = await getLead(tx, id);
    return finalRow;
  });
}

// --- Soft delete -----------------------------------------------------------

/**
 * DELETE /leads/:id — soft delete (sets `deleted_at`). Returns `false` when the
 * lead is absent or already soft-deleted (route → 404). No C4 event: the
 * taxonomy has no lead-deletion type.
 */
export async function softDeleteLead(db: Db, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const updated = await db
    .update(leads)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(leads.id, id), isNull(leads.deletedAt)))
    .returning({ id: leads.id });
  return updated.length > 0;
}
