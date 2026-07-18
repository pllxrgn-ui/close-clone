import { apiRequest } from '../../../api/client.ts';
import type { DialerEntry } from '../mocks/callingHandlers.ts';

/*
 * Typed REST wrappers for the calling endpoints (CONTRACTS §C7, mirroring
 * apps/api/src/routes/telephony.ts). Thin — the mock (callingHandlers) and, later,
 * the real API own the shapes; this just names the routes and threads bodies /
 * AbortSignals through the shared apiRequest client. Result shapes are the
 * service DTOs (DialOutcome, PatchCallResult, DialerQueue page, DropVoicemailResult).
 */

export interface DialInput {
  userId: string;
  leadId: string;
  contactId?: string;
  to?: string;
  from?: string;
  recordOptOut?: boolean;
}

/** `POST /calls/dial` and `POST /calls/dialer/advance` both return this. */
export interface DialOutcome {
  callId: string;
  callSid: string;
  to: string;
  from: string;
  recording: boolean;
}

export function dialCall(input: DialInput): Promise<DialOutcome> {
  return apiRequest<DialOutcome>('/calls/dial', { method: 'POST', body: input });
}

/** Sequential dialer advance — one live call per rep (server 409s otherwise). */
export function advanceDialer(input: DialInput): Promise<DialOutcome> {
  return apiRequest<DialOutcome>('/calls/dialer/advance', { method: 'POST', body: input });
}

export interface PatchCallInput {
  outcome?: string;
  notes?: string;
  actorId?: string;
}

export interface PatchCallResult {
  callId: string;
  outcome: string | null;
  noteId: string | null;
}

export function patchCall(callId: string, input: PatchCallInput): Promise<PatchCallResult> {
  return apiRequest<PatchCallResult>(`/calls/${callId}`, { method: 'PATCH', body: input });
}

export interface DropVoicemailResult {
  callId: string;
  recordingRef: string;
  activity: 'call_logged';
}

export function dropVoicemail(
  callId: string,
  input: { recordingRef: string; actorId?: string },
): Promise<DropVoicemailResult> {
  return apiRequest<DropVoicemailResult>(`/calls/${callId}/voicemail-drop`, {
    method: 'POST',
    body: input,
  });
}

export interface DialerQueueInput {
  userId: string;
  smartViewId?: string;
  dsl?: string;
  cursor?: string;
  limit?: number;
}

export interface DialerQueuePage {
  items: DialerEntry[];
  nextCursor?: string;
}

export function loadDialerQueue(
  input: DialerQueueInput,
  signal?: AbortSignal,
): Promise<DialerQueuePage> {
  return apiRequest<DialerQueuePage>('/calls/dialer/queue', {
    method: 'POST',
    body: input,
    ...(signal ? { signal } : {}),
  });
}
