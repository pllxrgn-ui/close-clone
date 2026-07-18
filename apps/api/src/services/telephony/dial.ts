import { and, eq, sql } from 'drizzle-orm';
import type { TelephonyProvider } from '@switchboard/shared/providers';
import { calls, contacts, leads, notes, type Db } from '../../db/index.ts';
import { recordActivity, type ActivityWebhookEmitter } from '../activity/index.ts';
import { isRecordingEnabled } from './recording.ts';
import { isPhoneSuppressed } from './suppression.ts';
import { phoneMatchKey } from './phone.ts';

/**
 * Outbound dial engine (CONTRACTS §C7 `POST /calls/dial`, §C6 I-DNC / I-REC). This
 * is the ONLY place a browser dial reaches the telephony provider, so the
 * compliance rails live here and the REST API cannot bypass them (I-RAIL-API):
 *
 *  - I-DNC (execution time): lead DNC, contact DNC, and an active phone suppression
 *    each BLOCK the dial — the provider is never called, and the route returns C8
 *    SUPPRESSED (422). This is a hard block, NOT an override prompt.
 *  - I-REC: recording is armed ONLY when `org_settings.recording_enabled` is true
 *    AND the rep did not opt out on this call; whenever recording is armed the
 *    consent announcement is armed with it (record ⇒ consent), so the adapter never
 *    records without consent.
 *
 * The provider call happens after the checks (mirroring the one-off email send):
 * a `calls` row is created only once Twilio has accepted the call and returned a
 * SID, which the status-callback ingress then advances.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export class DialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DialValidationError';
  }
}

export class DialLeadNotFoundError extends Error {
  constructor(leadId: string) {
    super(`lead ${leadId} not found or soft-deleted`);
    this.name = 'DialLeadNotFoundError';
  }
}

export class DialContactNotFoundError extends Error {
  constructor(contactId: string) {
    super(`contact ${contactId} not found or soft-deleted`);
    this.name = 'DialContactNotFoundError';
  }
}

/** Thrown when a compliance rail blocks the dial (I-DNC). Maps to C8 SUPPRESSED. */
export class DialBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`dial blocked: ${reason}`);
    this.name = 'DialBlockedError';
    this.reason = reason;
  }
}

/** Wraps a provider failure (maps to C8 PROVIDER_ERROR). */
export class DialProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DialProviderError';
  }
}

export interface DialDeps {
  db: Db;
  provider: Pick<TelephonyProvider, 'dial'>;
  now: () => Date;
  /** Default outbound caller-id (the org's Twilio number) when the call omits one. */
  callerId?: string;
}

export interface DialInput {
  userId: string;
  leadId: string;
  contactId?: string;
  /** Number to dial; defaults to the contact's first phone. */
  to?: string;
  /** Caller-id; defaults to `deps.callerId`. */
  from?: string;
  /** Per-call recording opt-out (rep declines recording even when enabled). */
  recordOptOut?: boolean;
}

export interface DialOutcome {
  callId: string;
  callSid: string;
  to: string;
  from: string;
  recording: boolean;
}

/** Place an outbound call through every compliance rail (I-DNC / I-REC). */
export async function dialCall(deps: DialDeps, input: DialInput): Promise<DialOutcome> {
  const nowIso = deps.now().toISOString();

  // Lead — must exist and not be soft-deleted; DNC blocks.
  const leadRows = await deps.db
    .select({ dnc: leads.dnc })
    .from(leads)
    .where(and(eq(leads.id, input.leadId), sql`${leads.deletedAt} is null`))
    .limit(1);
  const lead = leadRows[0];
  if (lead === undefined) throw new DialLeadNotFoundError(input.leadId);
  if (lead.dnc) throw new DialBlockedError('lead_dnc');

  // Contact — resolve the dial target + contact-level DNC.
  let toNumber = input.to ?? null;
  const contactId: string | null = input.contactId ?? null;
  if (input.contactId !== undefined) {
    const contactRows = await deps.db
      .select({ dnc: contacts.dnc, phones: contacts.phones, leadId: contacts.leadId })
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), sql`${contacts.deletedAt} is null`))
      .limit(1);
    const contact = contactRows[0];
    if (contact === undefined) throw new DialContactNotFoundError(input.contactId);
    if (contact.leadId !== input.leadId)
      throw new DialValidationError('contact does not belong to lead');
    if (contact.dnc) throw new DialBlockedError('contact_dnc');
    if (toNumber === null) toNumber = contact.phones[0]?.phone ?? null;
  }

  if (toNumber === null || toNumber.length === 0)
    throw new DialValidationError('no destination number (provide `to` or a contact with a phone)');
  const fromNumber = input.from ?? deps.callerId ?? null;
  if (fromNumber === null || fromNumber.length === 0)
    throw new DialValidationError('no caller id (provide `from` or configure a default)');

  // I-DNC / suppression: an active phone suppression blocks every dial path.
  if (await isPhoneSuppressed(deps.db, phoneMatchKey(toNumber))) {
    throw new DialBlockedError('phone_suppressed');
  }

  // I-REC: record only when org-enabled AND not opted out; consent tracks recording.
  // `isRecordingEnabled` (recording.ts) is the single authority for the org flag.
  const recordingEnabled = await isRecordingEnabled(deps.db);
  const record = recordingEnabled && input.recordOptOut !== true;

  let callSid: string;
  try {
    const res = await deps.provider.dial(fromNumber, toNumber, {
      record,
      consentAnnouncement: record,
    });
    callSid = res.callSid;
  } catch (err) {
    throw new DialProviderError(err instanceof Error ? err.message : String(err));
  }

  const inserted = await deps.db
    .insert(calls)
    .values({
      leadId: input.leadId,
      ...(contactId !== null ? { contactId } : {}),
      userId: input.userId,
      direction: 'outbound',
      twilioSid: callSid,
      status: 'queued',
      startedAt: nowIso,
    })
    .returning({ id: calls.id });
  const callId = inserted[0]!.id;

  return { callId, callSid, to: toNumber, from: fromNumber, recording: record };
}

// --- PATCH /calls/:id (outcome / notes) ------------------------------------

export class CallNotFoundError extends Error {
  constructor(callId: string) {
    super(`call ${callId} not found`);
    this.name = 'CallNotFoundError';
  }
}

export interface PatchCallDeps {
  db: Db;
  now: () => Date;
  /** Fans the call note onto activity.recorded webhooks. */
  emitter?: ActivityWebhookEmitter;
}

export interface PatchCallInput {
  outcome?: string;
  /** Free-text rep note about the call (rep-authored, never AI — see I-AI). */
  notes?: string;
  actorId?: string;
}

export interface PatchCallResult {
  callId: string;
  outcome: string | null;
  noteId: string | null;
}

/**
 * Update a call's `outcome` and/or attach a rep note. The note is authored by the
 * rep (`ai_generated=false`, `status='final'`) — this path never writes AI output,
 * so it is outside the §I-AI confirm-before-commit rail (that lives in the 3c call
 * summary path). Emits `note_added` for an attached note.
 */
export async function patchCall(
  deps: PatchCallDeps,
  callId: string,
  input: PatchCallInput,
): Promise<PatchCallResult> {
  const nowIso = deps.now().toISOString();
  return deps.db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const rows = await tx
      .select({ id: calls.id, leadId: calls.leadId, contactId: calls.contactId })
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);
    const call = rows[0];
    if (call === undefined) throw new CallNotFoundError(callId);

    if (input.outcome !== undefined) {
      await tx
        .update(calls)
        .set({ outcome: input.outcome, updatedAt: sql`now()` })
        .where(eq(calls.id, callId));
    }

    let noteId: string | null = null;
    if (input.notes !== undefined && input.notes.length > 0) {
      const noteRows = await tx
        .insert(notes)
        .values({
          leadId: call.leadId,
          ...(input.actorId !== undefined ? { authorId: input.actorId } : {}),
          bodyMd: input.notes,
          status: 'final',
          aiGenerated: false,
        })
        .returning({ id: notes.id });
      noteId = noteRows[0]!.id;
      await recordActivity(
        tx,
        {
          leadId: call.leadId,
          contactId: call.contactId,
          ...(input.actorId !== undefined ? { userId: input.actorId } : {}),
          type: 'note_added',
          occurredAt: nowIso,
          payload: { noteId, aiGenerated: false, channel: 'voice' },
        },
        deps.emitter,
      );
    }

    return {
      callId,
      outcome: input.outcome ?? null,
      noteId,
    };
  });
}
