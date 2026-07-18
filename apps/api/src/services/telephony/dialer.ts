import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  compile,
  type Ast,
  type CompileContext,
  type CompileOptions,
  type Cursor,
  type DslCustomFieldDef,
} from '@switchboard/shared';
import type { TelephonyProvider } from '@switchboard/shared/providers';
import { calls, contacts, leads, type Db } from '../../db/index.ts';
import { recordActivity, type ActivityWebhookEmitter } from '../activity/index.ts';
import { DialProviderError, dialCall, type DialInput, type DialOutcome } from './dial.ts';
import { isPhoneSuppressed } from './suppression.ts';
import { phoneMatchKey } from './phone.ts';

/**
 * The list dialer (task 3c). A SEQUENTIAL, rep-initiated power-dialer over a Smart
 * View — deliberately NOT predictive/parallel: exactly one live call per rep at a
 * time, and the rep advances by hand. Two moving parts:
 *
 *  1. The queue ({@link loadDialerQueue}). The Smart View AST is compiled by the
 *     SINGLE query authority (`@switchboard/shared` `compile` — C3, ARCH §1) into a
 *     keyset page of lead ids; each id is hydrated with its primary dialable contact
 *     and the compliance flags the UI needs to grey a row out. No hand-written WHERE
 *     — the compiler owns the query, so the dialer list and a saved-view preview are
 *     byte-identical.
 *  2. The advance ({@link advanceDialer}). Placing the next call goes through the
 *     3b {@link dialCall} engine (every I-DNC / I-REC rail), guarded by a
 *     one-live-call-per-rep check so "sequential only" is enforced server-side, not
 *     by UI convention.
 *
 * Plus voicemail drop ({@link dropVoicemailOnCall}): the rep drops a pre-recorded
 * asset into a live outbound call that reached a machine (`provider.dropVoicemail`),
 * and the call lands on the timeline as one `call_logged` (outcome `voicemail_drop`)
 * carrying the audio ref. The dropped asset is the rep's own recording, never a
 * consent-gated conversation recording, so §I-REC does not apply to it (C2 DTO note).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** Minimal raw-SQL runner (the PGlite/pg client); the compiler emits `$n` params. */
export interface RawQueryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Call statuses that mean a call is still live (blocks a sequential advance). */
export const ACTIVE_CALL_STATUSES = ['queued', 'ringing', 'answered'] as const;

const DEFAULT_QUEUE_LIMIT = 25;
const MAX_QUEUE_LIMIT = 100;
const EMPTY_CATALOG: readonly DslCustomFieldDef[] = [];

// --- Errors ----------------------------------------------------------------

/** Sequential guard tripped: the rep already has a live call. Maps to C8 CONFLICT. */
export class DialerBusyError extends Error {
  readonly activeCallId: string;
  constructor(activeCallId: string) {
    super('a call is already in progress for this user (sequential dialer)');
    this.name = 'DialerBusyError';
    this.activeCallId = activeCallId;
  }
}

/** Voicemail-drop target call not found. Maps to C8 NOT_FOUND. */
export class DropCallNotFoundError extends Error {
  readonly callId: string;
  constructor(callId: string) {
    super(`call ${callId} not found`);
    this.name = 'DropCallNotFoundError';
    this.callId = callId;
  }
}

/** Drop attempted on a call that is not a dialable outbound call. C8 VALIDATION. */
export class DropCallNotDialableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DropCallNotDialableError';
  }
}

/** Drop attempted on a call already finalized (terminal event exists). C8 CONFLICT. */
export class DropCallAlreadyFinalizedError extends Error {
  readonly callId: string;
  constructor(callId: string) {
    super(`call ${callId} is already finalized`);
    this.name = 'DropCallAlreadyFinalizedError';
    this.callId = callId;
  }
}

// --- Queue -----------------------------------------------------------------

export interface DialerQueueDeps {
  db: Db;
  client: RawQueryable;
  /** Org timezone for relative-date resolution (C3). Defaults to UTC. */
  orgTimezone?: string;
  /** Custom-field catalog the compiler whitelists `custom.<key>` against. */
  fieldCatalog?: readonly DslCustomFieldDef[];
  now?: () => Date;
}

export interface DialerQueueInput {
  /** Compiled Smart View AST (the dialer does not re-parse; callers pass the AST). */
  ast: Ast;
  /** Binds `owner in (me)` and relative-date `me` at execution time (C3). */
  currentUserId: string;
  cursor?: Cursor;
  limit?: number;
}

export interface DialerEntry {
  leadId: string;
  leadName: string;
  /** Primary dialable contact (first non-deleted contact with a phone), if any. */
  contactId: string | null;
  phone: string | null;
  /** Lead- or contact-level DNC (I-DNC surface for the UI; the dial re-checks). */
  dnc: boolean;
  /** The primary phone is on an active suppression (I-DNC/I-QUIET surface). */
  suppressed: boolean;
  /** Convenience: a number is present and no compliance rail would block the dial. */
  dialable: boolean;
}

export interface DialerQueue {
  entries: DialerEntry[];
  nextCursor?: Cursor;
}

interface LeadRow {
  id: string;
  name: string;
  dnc: boolean;
  createdAt: string;
}

interface ContactRow {
  id: string;
  leadId: string;
  dnc: boolean;
  phones: { phone: string; type?: string }[];
  createdAt: string;
}

/**
 * Build one keyset page of the dialer queue from a Smart View AST. The page is
 * ordered by the compiler's default sort (created desc); `nextCursor` (when
 * present) drives the next page. Each entry is annotated so the caller can render
 * a blocked row without attempting the dial.
 */
export async function loadDialerQueue(
  deps: DialerQueueDeps,
  input: DialerQueueInput,
): Promise<DialerQueue> {
  const limit = clampLimit(input.limit);
  const ctx: CompileContext = {
    currentUserId: input.currentUserId,
    orgTimezone: deps.orgTimezone ?? 'UTC',
    fieldCatalog: deps.fieldCatalog ?? EMPTY_CATALOG,
    now: (deps.now ?? (() => new Date()))(),
  };
  const options: CompileOptions = {
    limit: limit + 1, // fetch one extra to detect a next page
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  };
  const compiled = compile(input.ast, ctx, options);
  const idRes = await deps.client.query<{ id: string }>(compiled.sql, compiled.params);
  const orderedIds = idRes.rows.map((r) => r.id);
  const hasMore = orderedIds.length > limit;
  const pageIds = hasMore ? orderedIds.slice(0, limit) : orderedIds;
  if (pageIds.length === 0) return { entries: [] };

  // Hydrate leads + their contacts in two batched reads, preserving compiled order.
  const leadRows = (await deps.db
    .select({
      id: leads.id,
      name: leads.name,
      dnc: leads.dnc,
      createdAt: leads.createdAt,
    })
    .from(leads)
    .where(inArray(leads.id, pageIds))) as LeadRow[];
  const leadById = new Map(leadRows.map((r) => [r.id, r]));

  const contactRows = (await deps.db
    .select({
      id: contacts.id,
      leadId: contacts.leadId,
      dnc: contacts.dnc,
      phones: contacts.phones,
      createdAt: contacts.createdAt,
    })
    .from(contacts)
    .where(and(inArray(contacts.leadId, pageIds), isNull(contacts.deletedAt)))
    .orderBy(asc(contacts.createdAt), asc(contacts.id))) as ContactRow[];
  const contactsByLead = new Map<string, ContactRow[]>();
  for (const c of contactRows) {
    const list = contactsByLead.get(c.leadId) ?? [];
    list.push(c);
    contactsByLead.set(c.leadId, list);
  }

  const entries: DialerEntry[] = [];
  for (const leadId of pageIds) {
    const lead = leadById.get(leadId);
    if (lead === undefined) continue; // raced deletion between compile and hydrate
    const primary = pickPrimaryContact(contactsByLead.get(leadId) ?? []);
    const phone = primary?.phone ?? null;
    const dnc = lead.dnc || (primary?.dnc ?? false);
    const suppressed =
      phone !== null ? await isPhoneSuppressed(deps.db, phoneMatchKey(phone)) : false;
    entries.push({
      leadId,
      leadName: lead.name,
      contactId: primary?.contactId ?? null,
      phone,
      dnc,
      suppressed,
      dialable: phone !== null && !dnc && !suppressed,
    });
  }

  if (hasMore) {
    const lastId = pageIds[pageIds.length - 1];
    const lastLead = lastId !== undefined ? leadById.get(lastId) : undefined;
    if (lastLead !== undefined) {
      return { entries, nextCursor: { sortValue: lastLead.createdAt, id: lastLead.id } };
    }
  }
  return { entries };
}

function pickPrimaryContact(
  rows: ContactRow[],
): { contactId: string; phone: string; dnc: boolean } | null {
  for (const c of rows) {
    const phone = c.phones[0]?.phone;
    if (phone !== undefined && phone.length > 0) {
      return { contactId: c.id, phone, dnc: c.dnc };
    }
  }
  return null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_QUEUE_LIMIT;
  return Math.max(1, Math.min(MAX_QUEUE_LIMIT, Math.floor(limit)));
}

// --- Advance (sequential dial) ---------------------------------------------

export interface DialerAdvanceDeps {
  db: Db;
  provider: Pick<TelephonyProvider, 'dial'>;
  now: () => Date;
  callerId?: string;
}

/**
 * Place the next call in the dialer. SEQUENTIAL: rejects with {@link DialerBusyError}
 * if the rep already has a live call (`queued`/`ringing`/`answered`), so a rep can
 * never fan out into parallel/predictive dialing through this path. Otherwise the
 * call is placed through the 3b {@link dialCall} engine (all I-DNC / I-REC rails).
 */
export async function advanceDialer(
  deps: DialerAdvanceDeps,
  input: DialInput,
): Promise<DialOutcome> {
  const active = await deps.db
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.userId, input.userId), inArray(calls.status, [...ACTIVE_CALL_STATUSES])))
    .limit(1);
  const live = active[0];
  if (live !== undefined) throw new DialerBusyError(live.id);

  return dialCall(
    {
      db: deps.db,
      provider: deps.provider,
      now: deps.now,
      ...(deps.callerId !== undefined ? { callerId: deps.callerId } : {}),
    },
    input,
  );
}

// --- Voicemail drop --------------------------------------------------------

export interface DropVoicemailDeps {
  db: Db;
  provider: Pick<TelephonyProvider, 'dropVoicemail'>;
  now: () => Date;
  /** Fans call_logged onto activity.recorded webhooks. */
  emitter?: ActivityWebhookEmitter;
}

export interface DropVoicemailInput {
  callId: string;
  /** The rep's pre-recorded voicemail asset handle (NOT a conversation recording). */
  recordingRef: string;
  /** Actor attributed on the timeline event (the rep). */
  actorId?: string;
}

export interface DropVoicemailResult {
  callId: string;
  recordingRef: string;
  activity: 'call_logged';
}

interface DropCallRow {
  id: string;
  leadId: string;
  contactId: string | null;
  userId: string | null;
  direction: string;
  twilioSid: string | null;
}

/**
 * Drop a pre-recorded voicemail into a live outbound call (`provider.dropVoicemail`)
 * and record it. The provider call happens OUTSIDE the DB transaction (mirroring the
 * send/dispatch pattern); the timeline write is guarded so a re-drop or a later
 * async terminal status callback is a no-op (exactly one `call_logged` per call).
 */
export async function dropVoicemailOnCall(
  deps: DropVoicemailDeps,
  input: DropVoicemailInput,
): Promise<DropVoicemailResult> {
  if (input.recordingRef.length === 0) {
    throw new DropCallNotDialableError('a voicemail recordingRef is required');
  }
  const rows = await deps.db
    .select({
      id: calls.id,
      leadId: calls.leadId,
      contactId: calls.contactId,
      userId: calls.userId,
      direction: calls.direction,
      twilioSid: calls.twilioSid,
    })
    .from(calls)
    .where(eq(calls.id, input.callId))
    .limit(1);
  const call = rows[0] as DropCallRow | undefined;
  if (call === undefined) throw new DropCallNotFoundError(input.callId);
  if (call.direction !== 'outbound' || call.twilioSid === null) {
    throw new DropCallNotDialableError('voicemail drop requires a live outbound call');
  }
  // Refuse a drop on an already-finalized call BEFORE touching the provider.
  if (await hasTerminalCallActivity(deps.db, call.leadId, call.id)) {
    throw new DropCallAlreadyFinalizedError(call.id);
  }

  try {
    await deps.provider.dropVoicemail(call.twilioSid, input.recordingRef);
  } catch (err) {
    throw new DialProviderError(err instanceof Error ? err.message : String(err));
  }

  const nowIso = deps.now().toISOString();
  await deps.db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    // Re-check inside the txn to close the drop-vs-terminal race.
    if (await hasTerminalCallActivity(tx, call.leadId, call.id)) {
      throw new DropCallAlreadyFinalizedError(call.id);
    }
    await tx
      .update(calls)
      .set({
        status: 'voicemail',
        outcome: 'voicemail_drop',
        recordingRef: input.recordingRef,
        endedAt: nowIso,
        updatedAt: sql`now()`,
      })
      .where(eq(calls.id, call.id));

    await recordActivity(
      tx,
      {
        leadId: call.leadId,
        contactId: call.contactId,
        ...(input.actorId !== undefined
          ? { userId: input.actorId }
          : call.userId !== null
            ? { userId: call.userId }
            : {}),
        type: 'call_logged',
        occurredAt: nowIso,
        payload: {
          callId: call.id,
          direction: 'outbound',
          outcome: 'voicemail_drop',
          recordingRef: input.recordingRef,
          voicemailDropped: true,
          channel: 'voice',
        },
      },
      deps.emitter,
    );
  });

  return { callId: call.id, recordingRef: input.recordingRef, activity: 'call_logged' };
}

/** A terminal call activity (the exactly-once guard) already exists for this call. */
async function hasTerminalCallActivity(db: Db, leadId: string, callId: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM activities
    WHERE lead_id = ${leadId}
      AND type IN ('call_logged', 'call_missed', 'voicemail_received')
      AND payload->>'callId' = ${callId}
    LIMIT 1
  `);
  return (result as { rows: unknown[] }).rows.length > 0;
}
