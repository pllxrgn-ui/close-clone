import type { Contact, SmsMessage } from '@switchboard/shared';
import { apiRequest } from '../../../api/client.ts';

/*
 * Typed REST wrappers for the two-way SMS surface (CONTRACTS §C7). Thin — the mock
 * (smsHandlers) and, later, the real API own the shapes; this just names the routes
 * and threads AbortSignals through the shared apiRequest client.
 *
 * SEND is the frozen real route `POST /sms/send` (apps/api/src/routes/sms.ts): the
 * request body and the `SmsSendResult` response mirror it EXACTLY, so the composer
 * works unchanged when real Twilio credentials land. Every compliance rail
 * (I-DNC/suppression → SUPPRESSED, I-QUIET → OUTSIDE_WINDOW) is enforced server-side
 * and surfaced here as a typed ApiError — the API cannot be made to bypass them.
 *
 * READ (the conversation thread) calls `GET /leads/:id/sms` → `{ items }`. NOTE
 * (reported upward as contract friction): no C7 route currently returns a lead's
 * sms_messages — this is the natural lead-scoped companion to `POST /sms/send`, and
 * the shape is the C1 `SmsMessage` row so it is a drop-in once the route is added.
 */

/** A lead's SMS conversation, chronological (oldest → newest). */
export function listSmsThread(leadId: string, signal?: AbortSignal): Promise<SmsMessage[]> {
  return apiRequest<{ items: SmsMessage[] }>(`/leads/${leadId}/sms`, signal ? { signal } : {}).then(
    (res) => res.items,
  );
}

/** A lead's contacts (served by the leads feature's `/contacts?leadId=` handler). */
export function listLeadContacts(leadId: string, signal?: AbortSignal): Promise<Contact[]> {
  return apiRequest<Contact[]>('/contacts', {
    query: { leadId },
    ...(signal ? { signal } : {}),
  });
}

/** The `POST /sms/send` request body (mirror of the real route's zod schema). */
export interface SendSmsInput {
  /** The rep performing the send (recorded on the activity + sms row). */
  userId: string;
  /** Timeline target. */
  leadId: string;
  /** Recipient contact — DNC + the default destination number. */
  contactId?: string | null;
  /** Destination number; defaults server-side to the contact's first phone. */
  to?: string;
  /** Sender number; defaults server-side to the org number. */
  from?: string;
  /** Message body (opt-out language is appended server-side on first contact). */
  body: string;
  /** Client key for safe retries (same key ⇒ one send, one activity). */
  idempotencyKey?: string;
}

/** The `POST /sms/send` response (mirror of the real route's `SmsSendResult`). */
export interface SmsSendResult {
  smsMessageId: string;
  leadId: string;
  to: string;
  from: string;
  providerSid: string;
  /** The body actually sent (may include appended first-contact opt-out language). */
  body: string;
  /** True iff §4.5 first-contact opt-out language was appended to the body. */
  optOutLanguageAppended: boolean;
  /** True iff a prior send with the same idempotency key already delivered this. */
  deduped: boolean;
}

export function sendSms(input: SendSmsInput): Promise<SmsSendResult> {
  const body: Record<string, string> = {
    userId: input.userId,
    leadId: input.leadId,
    body: input.body,
  };
  if (input.contactId != null) body.contactId = input.contactId;
  if (input.to !== undefined) body.to = input.to;
  if (input.from !== undefined) body.from = input.from;
  if (input.idempotencyKey !== undefined) body.idempotencyKey = input.idempotencyKey;
  return apiRequest<SmsSendResult>('/sms/send', { method: 'POST', body });
}
