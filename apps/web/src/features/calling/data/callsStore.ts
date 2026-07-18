/*
 * The calling feature's in-memory store — the demo's server-side call state,
 * mirroring the comms store pattern (module-scope, seeded read-only from the
 * shared fixture `db`, mutated by the MSW handlers so a dialed call persists
 * across route changes and resets on reload). Rows are the @switchboard/shared
 * C1 `Call` DTO so the identical UI drives the real API later.
 *
 * Two compliance surfaces live here so the mock rails match the engine's:
 *   - `suppressedPhones` — active phone suppressions (I-DNC); seeded with one
 *     number so a NON-DNC lead can still be blocked, proving suppression ≠ DNC.
 *   - `recordingEnabled` — the org_settings.recording_enabled flag (I-REC);
 *     seeded on so the consent announcement + REC indicator are demonstrable.
 */
import type { Call } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import { phoneMatchKey } from '../lib/presets.ts';

/** Statuses that mean a call is still on the wire (mirrors dialer.ACTIVE_CALL_STATUSES). */
export const ACTIVE_CALL_STATUSES: readonly Call['status'][] = ['queued', 'ringing', 'answered'];

/** Default outbound caller-id (the org's Twilio number) for the demo. */
export const DEMO_CALLER_ID = '+12065550100';

export interface CallsState {
  /** Calls created this session (newest first). */
  calls: Call[];
  /** Active phone suppressions, keyed by {@link phoneMatchKey}. */
  suppressedPhones: Set<string>;
  /** org_settings.recording_enabled (admin+audit-gated in the real system). */
  recordingEnabled: boolean;
}

/** First non-DNC lead+contact phone, seeded as a suppression (suppression ≠ DNC). */
function seedSuppressedPhone(): Set<string> {
  const suppressed = new Set<string>();
  for (const lead of db.leads) {
    if (lead.dnc || lead.deletedAt !== null) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && !c.dnc && c.phones.length > 0,
    );
    const phone = contact?.phones[0]?.phone;
    if (phone) {
      suppressed.add(phoneMatchKey(phone));
      break;
    }
  }
  return suppressed;
}

function buildInitialState(): CallsState {
  return {
    calls: [],
    suppressedPhones: seedSuppressedPhone(),
    recordingEnabled: true,
  };
}

/** The live, mutable store. Handlers read and write this object. */
export const callsStore: CallsState = buildInitialState();

/** Re-seed to the initial deterministic state (used by tests for isolation). */
export function resetCallsStore(): void {
  const fresh = buildInitialState();
  callsStore.calls = fresh.calls;
  callsStore.suppressedPhones = fresh.suppressedPhones;
  callsStore.recordingEnabled = fresh.recordingEnabled;
}

export function findCall(callId: string): Call | undefined {
  return callsStore.calls.find((c) => c.id === callId);
}

/** The rep's current live call, if any (drives the sequential-dialer guard). */
export function activeCallForUser(userId: string): Call | undefined {
  return callsStore.calls.find(
    (c) => c.userId === userId && ACTIVE_CALL_STATUSES.includes(c.status),
  );
}

export function isPhoneSuppressed(phone: string): boolean {
  return callsStore.suppressedPhones.has(phoneMatchKey(phone));
}

/** Insert a freshly-dialed outbound call row (status `queued`). */
export function insertOutboundCall(input: {
  leadId: string;
  contactId: string | null;
  userId: string;
  twilioSid: string;
  startedAt: string;
}): Call {
  const now = new Date().toISOString();
  const call: Call = {
    id: crypto.randomUUID(),
    leadId: input.leadId,
    contactId: input.contactId,
    userId: input.userId,
    direction: 'outbound',
    twilioSid: input.twilioSid,
    status: 'queued',
    durationS: null,
    outcome: null,
    recordingRef: null,
    transcriptRef: null,
    startedAt: input.startedAt,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  callsStore.calls.unshift(call);
  return call;
}
