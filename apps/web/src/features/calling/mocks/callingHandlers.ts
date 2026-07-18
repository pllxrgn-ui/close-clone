import { http, HttpResponse } from 'msw';
import type { Activity, Contact, Lead } from '@switchboard/shared';
import { parse, ParseError } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import {
  ACTIVE_CALL_STATUSES,
  DEMO_CALLER_ID,
  activeCallForUser,
  callsStore,
  findCall,
  insertOutboundCall,
  isPhoneSuppressed,
} from '../data/callsStore.ts';
import { dispositionForOutcome } from '../lib/presets.ts';
import { dispositionToStatus } from '../lib/lifecycle.ts';

/*
 * Additive MSW handlers for the built-in calling surfaces (U1), matching the real
 * telephony route (apps/api/src/routes/telephony.ts) shapes exactly — camelCase,
 * `{error:{code,message,details?}}` per §C8 — so this layer is a drop-in for the
 * demo and the identical UI drives the real API later. The §C6 rails are enforced
 * HERE, server-side: a DNC lead/contact or a suppressed number is a hard 422
 * SUPPRESSED (never an override), the sequential dialer is a 409 CONFLICT while a
 * call is live, and recording arms the consent announcement (I-REC).
 *
 * Routes (all under `/api/v1`):
 *   POST /calls/dial              → DialOutcome
 *   PATCH /calls/:id              → PatchCallResult (+ finalizes the demo call)
 *   POST /calls/dialer/queue      → { items, nextCursor? }
 *   POST /calls/dialer/advance    → DialOutcome (sequential guard)
 *   POST /calls/:id/voicemail-drop→ DropVoicemailResult
 *
 * Registered like the other feature handler arrays: `server.use(...callingHandlers)`
 * in tests and spread into the worker/server handler list at merge (routeWiring).
 */

const api = (path: string): string => `*/api/v1${path}`;

function errorJson(status: number, code: string, message: string, details?: unknown) {
  const body =
    details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  return HttpResponse.json(body, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Append a C4 activity to the shared timeline store (newest-first, like comms). */
function appendActivity(input: {
  leadId: string;
  contactId?: string | null;
  userId?: string | null;
  type: string;
  payload: Record<string, unknown>;
}): Activity {
  const now = new Date().toISOString();
  const activity: Activity = {
    id: crypto.randomUUID(),
    leadId: input.leadId,
    contactId: input.contactId ?? null,
    userId: input.userId ?? null,
    type: input.type,
    occurredAt: now,
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
  };
  const existing = db.activitiesByLead.get(input.leadId);
  if (existing) existing.unshift(activity);
  else db.activitiesByLead.set(input.leadId, [activity]);
  return activity;
}

/** A terminal `call_logged` already exists for this call (exactly-once guard). */
function hasCallLogged(leadId: string, callId: string): boolean {
  const events = db.activitiesByLead.get(leadId);
  if (!events) return false;
  return events.some(
    (e) => e.type === 'call_logged' && isRecord(e.payload) && e.payload.callId === callId,
  );
}

function twilioSid(): string {
  return `CA${crypto.randomUUID().replace(/-/g, '')}`;
}

// ── Shared dial resolution (I-DNC / I-REC), used by /dial and /dialer/advance ──

type DialResolution =
  | {
      ok: true;
      leadId: string;
      contactId: string | null;
      to: string;
      from: string;
      record: boolean;
    }
  | { ok: false; response: Response };

function resolveDial(body: Record<string, unknown>): DialResolution {
  const userId = str(body.userId);
  const leadId = str(body.leadId);
  if (!userId || !leadId) {
    return {
      ok: false,
      response: errorJson(400, 'VALIDATION_FAILED', 'userId and leadId are required'),
    };
  }

  const lead = db.leads.find((l) => l.id === leadId && l.deletedAt === null);
  if (!lead)
    return { ok: false, response: errorJson(404, 'NOT_FOUND', `lead ${leadId} not found`) };
  if (lead.dnc) {
    return { ok: false, response: errorJson(422, 'SUPPRESSED', 'dial blocked: lead_dnc') };
  }

  const explicitContactId = str(body.contactId);
  let contactId: string | null = explicitContactId;
  let toNumber = str(body.to);

  if (explicitContactId) {
    const contact = db.contacts.find((c) => c.id === explicitContactId && c.deletedAt === null);
    if (!contact) {
      return {
        ok: false,
        response: errorJson(404, 'NOT_FOUND', `contact ${explicitContactId} not found`),
      };
    }
    if (contact.leadId !== leadId) {
      return {
        ok: false,
        response: errorJson(400, 'VALIDATION_FAILED', 'contact does not belong to lead'),
      };
    }
    if (contact.dnc) {
      return { ok: false, response: errorJson(422, 'SUPPRESSED', 'dial blocked: contact_dnc') };
    }
    if (!toNumber) toNumber = contact.phones[0]?.phone ?? null;
  } else if (!toNumber) {
    // Resolve the primary dialable contact (first non-deleted with a phone).
    const primary = db.contacts.find(
      (c) => c.leadId === leadId && c.deletedAt === null && c.phones.length > 0,
    );
    if (primary) {
      contactId = primary.id;
      if (primary.dnc) {
        return { ok: false, response: errorJson(422, 'SUPPRESSED', 'dial blocked: contact_dnc') };
      }
      toNumber = primary.phones[0]?.phone ?? null;
    }
  }

  if (!toNumber) {
    return {
      ok: false,
      response: errorJson(
        400,
        'VALIDATION_FAILED',
        'no destination number (provide `to` or a contact with a phone)',
      ),
    };
  }
  if (isPhoneSuppressed(toNumber)) {
    return { ok: false, response: errorJson(422, 'SUPPRESSED', 'dial blocked: phone_suppressed') };
  }

  const from = str(body.from) ?? DEMO_CALLER_ID;
  const record = callsStore.recordingEnabled && body.recordOptOut !== true;
  return { ok: true, leadId, contactId, to: toNumber, from, record };
}

/** Place a call: create the row and (when armed) log the consent announcement. */
function placeCall(userId: string, r: Extract<DialResolution, { ok: true }>) {
  const startedAt = new Date().toISOString();
  const sid = twilioSid();
  const call = insertOutboundCall({
    leadId: r.leadId,
    contactId: r.contactId,
    userId,
    twilioSid: sid,
    startedAt,
  });
  // I-REC: recording arms the consent announcement, and the consent event
  // precedes recording start — so the timeline shows consent before the call log.
  if (r.record) {
    appendActivity({
      leadId: r.leadId,
      contactId: r.contactId,
      userId,
      type: 'recording_consent_played',
      payload: { callId: call.id, channel: 'voice' },
    });
  }
  return HttpResponse.json({
    callId: call.id,
    callSid: sid,
    to: r.to,
    from: r.from,
    recording: r.record,
  });
}

// ── Dialer queue (fixture-derived; real route compiles the Smart View AST) ─────

export interface DialerEntry {
  leadId: string;
  leadName: string;
  contactId: string | null;
  phone: string | null;
  dnc: boolean;
  suppressed: boolean;
  dialable: boolean;
}

function primaryPhoneContact(leadId: string): Contact | undefined {
  return db.contacts.find(
    (c) => c.leadId === leadId && c.deletedAt === null && c.phones.length > 0,
  );
}

function toEntry(lead: Lead): DialerEntry | null {
  const contact = primaryPhoneContact(lead.id);
  const phone = contact?.phones[0]?.phone ?? null;
  if (phone === null) return null; // not a callable lead — off the dialer queue
  const dnc = lead.dnc || (contact?.dnc ?? false);
  const suppressed = isPhoneSuppressed(phone);
  return {
    leadId: lead.id,
    leadName: lead.name,
    contactId: contact?.id ?? null,
    phone,
    dnc,
    suppressed,
    dialable: !dnc && !suppressed,
  };
}

/** All callable leads in the fixture, in the leads-list default order. */
function buildDialerCandidates(): DialerEntry[] {
  const entries: DialerEntry[] = [];
  for (const lead of db.leads) {
    if (lead.deletedAt !== null) continue;
    const entry = toEntry(lead);
    if (entry) entries.push(entry);
  }
  return entries;
}

function encodeCursor(leadId: string): string {
  return btoa(`k:${leadId}`);
}
function decodeCursor(cursor: string): string | null {
  try {
    const decoded = atob(cursor);
    return decoded.startsWith('k:') ? decoded.slice(2) : null;
  } catch {
    return null;
  }
}
function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return Math.min(Math.floor(n), 100);
}

export const callingHandlers = [
  // ── POST /calls/dial — the dialer (I-DNC / I-REC rails in the engine) ───────
  http.post(api('/calls/dial'), async ({ request }) => {
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');
    const userId = str(body.userId);
    const resolved = resolveDial(body);
    if (!resolved.ok) return resolved.response;
    return placeCall(userId as string, resolved);
  }),

  // ── PATCH /calls/:id — outcome + rep note; finalizes the demo call ──────────
  // DEMO NOTE: in production the terminal `call_logged` is emitted by the Twilio
  // status-callback worker (processTwilioInboxRow). The mock has no ingress
  // worker, so the rep's outcome submit stands in as the finalization moment —
  // it stamps the terminal C1 status and lands the call on the timeline. The
  // note path mirrors the real patchCall (rep-authored, never AI → note_added).
  http.patch(api('/calls/:id'), async ({ params, request }) => {
    const callId = String(params.id);
    const call = findCall(callId);
    if (!call) return errorJson(404, 'NOT_FOUND', `call ${callId} not found`);
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');

    const outcome = str(body.outcome);
    const notes = str(body.notes);
    const actorId = str(body.actorId) ?? call.userId;
    const now = new Date().toISOString();

    if (outcome) {
      call.outcome = outcome;
      // Finalize once: stamp the terminal status + duration and log to the timeline.
      if (ACTIVE_CALL_STATUSES.includes(call.status) && !hasCallLogged(call.leadId, call.id)) {
        const startedMs = call.startedAt ? Date.parse(call.startedAt) : Date.parse(now);
        call.status = dispositionToStatus(dispositionForOutcome(outcome));
        call.endedAt = now;
        call.durationS = Math.max(0, Math.floor((Date.parse(now) - startedMs) / 1000));
        call.updatedAt = now;
        appendActivity({
          leadId: call.leadId,
          contactId: call.contactId,
          userId: actorId,
          type: 'call_logged',
          payload: {
            callId: call.id,
            direction: 'outbound',
            outcome,
            durationS: call.durationS,
            recording: call.recordingRef !== null,
            channel: 'voice',
          },
        });
      }
    }

    let noteId: string | null = null;
    if (notes) {
      noteId = crypto.randomUUID();
      call.updatedAt = now;
      appendActivity({
        leadId: call.leadId,
        contactId: call.contactId,
        userId: actorId,
        type: 'note_added',
        payload: { noteId, aiGenerated: false, channel: 'voice' },
      });
    }

    return HttpResponse.json({ callId: call.id, outcome: outcome ?? null, noteId });
  }),

  // ── POST /calls/dialer/queue — one keyset page over a Smart View ───────────
  http.post(api('/calls/dialer/queue'), async ({ request }) => {
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');
    if (!str(body.userId)) return errorJson(400, 'VALIDATION_FAILED', 'userId is required');
    const hasSource =
      str(body.smartViewId) !== null || str(body.dsl) !== null || body.ast !== undefined;
    if (!hasSource) {
      return errorJson(400, 'VALIDATION_FAILED', 'provide one of smartViewId, dsl, or ast');
    }
    // Validate the source the way the real route does (existence / parse), even
    // though the mock does not evaluate the filter (parity with smart-views/preview).
    const smartViewId = str(body.smartViewId);
    if (smartViewId && !db.smartViews.some((v) => v.id === smartViewId)) {
      return errorJson(404, 'NOT_FOUND', 'smart view not found');
    }
    const dsl = str(body.dsl);
    if (dsl) {
      try {
        parse(dsl);
      } catch (err) {
        if (err instanceof ParseError) return errorJson(400, 'VALIDATION_FAILED', err.message);
        throw err;
      }
    }

    const all = buildDialerCandidates();
    const limit = clampLimit(body.limit);
    const cursor = str(body.cursor);
    let start = 0;
    if (cursor) {
      const afterId = decodeCursor(cursor);
      if (afterId === null) return errorJson(400, 'VALIDATION_FAILED', 'invalid cursor');
      const idx = all.findIndex((e) => e.leadId === afterId);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const items = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    const last = items[items.length - 1];
    return HttpResponse.json(
      hasMore && last ? { items, nextCursor: encodeCursor(last.leadId) } : { items },
    );
  }),

  // ── POST /calls/dialer/advance — place the next call SEQUENTIALLY ───────────
  http.post(api('/calls/dialer/advance'), async ({ request }) => {
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');
    const userId = str(body.userId);
    if (!userId) return errorJson(400, 'VALIDATION_FAILED', 'userId is required');
    // Sequential guard: one live call per rep (C8 CONFLICT), never predictive.
    if (activeCallForUser(userId)) {
      return errorJson(
        409,
        'CONFLICT',
        'a call is already in progress for this user (sequential dialer)',
      );
    }
    const resolved = resolveDial(body);
    if (!resolved.ok) return resolved.response;
    return placeCall(userId, resolved);
  }),

  // ── POST /calls/:id/voicemail-drop — drop a pre-recorded asset ─────────────
  http.post(api('/calls/:id/voicemail-drop'), async ({ params, request }) => {
    const callId = String(params.id);
    const call = findCall(callId);
    if (!call) return errorJson(404, 'NOT_FOUND', `call ${callId} not found`);
    const body = await readJson(request);
    const recordingRef = body ? str(body.recordingRef) : null;
    if (!recordingRef)
      return errorJson(400, 'VALIDATION_FAILED', 'a voicemail recordingRef is required');
    if (call.direction !== 'outbound' || call.twilioSid === null) {
      return errorJson(400, 'VALIDATION_FAILED', 'voicemail drop requires a live outbound call');
    }
    if (hasCallLogged(call.leadId, call.id)) {
      return errorJson(409, 'CONFLICT', `call ${call.id} is already finalized`);
    }
    const actorId = (body ? str(body.actorId) : null) ?? call.userId;
    const now = new Date().toISOString();
    const startedMs = call.startedAt ? Date.parse(call.startedAt) : Date.parse(now);
    call.status = 'voicemail';
    call.outcome = 'voicemail_drop';
    call.recordingRef = recordingRef;
    call.endedAt = now;
    call.durationS = Math.max(0, Math.floor((Date.parse(now) - startedMs) / 1000));
    call.updatedAt = now;
    appendActivity({
      leadId: call.leadId,
      contactId: call.contactId,
      userId: actorId,
      type: 'call_logged',
      payload: {
        callId: call.id,
        direction: 'outbound',
        outcome: 'voicemail_drop',
        recordingRef,
        voicemailDropped: true,
        channel: 'voice',
      },
    });
    return HttpResponse.json({ callId: call.id, recordingRef, activity: 'call_logged' });
  }),
];
