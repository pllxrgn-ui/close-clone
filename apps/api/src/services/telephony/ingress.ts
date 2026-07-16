import { webhookInbox, type Db } from '../../db/index.ts';
import {
  TWILIO_SIGNATURE_HEADER,
  parseFormBody,
  readHeader,
  verifyTwilioSignature,
} from '../../providers/telephony/twilio-signature.ts';

/**
 * Twilio ingress: parse + verify + persist (CONTRACTS §C7 `/wh/twilio/*`,
 * ARCHITECTURE §5 persist-then-process). The HTTP route ONLY verifies the
 * `X-Twilio-Signature`, stores the raw form params in `webhook_inbox` keyed by a
 * deterministic `provider_event_id`, and fast-200s. A SEPARATE idempotent worker
 * (`process.ts`) maps the stored rows to C4 timeline events — so replaying any
 * webhook is a no-op by the same argument as the Gmail/sync inbox.
 *
 * The three channels share this path; they differ only in how the dedupe key is
 * derived from Twilio's params (a call has many callbacks, so the key must be
 * per-lifecycle-event, not per-call).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type TwilioChannel = 'voice' | 'sms' | 'status';

export class InvalidTwilioWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTwilioWebhookError';
  }
}

export interface ParsedTwilioWebhook {
  /** `webhook_inbox` dedupe key — unique per lifecycle event, not per call. */
  eventId: string;
  channel: TwilioChannel;
  params: Record<string, string>;
}

/**
 * Derive a stable, per-event dedupe key from Twilio's params:
 *  - sms          → `MessageSid` (one row per inbound message);
 *  - voice        → `<CallSid>:voice` (one TwiML request per inbound call);
 *  - status:
 *      recording  → `<CallSid>:rec:<RecordingSid>:<RecordingStatus>`;
 *      call       → `<CallSid>:call:<CallStatus>:<SequenceNumber>`.
 * Two DISTINCT lifecycle callbacks never collide; a REPLAY of the same callback
 * yields the same key, so the unique index makes it a no-op.
 */
export function parseTwilioWebhook(channel: TwilioChannel, rawBody: string): ParsedTwilioWebhook {
  const params = parseFormBody(rawBody);

  if (channel === 'sms') {
    const messageSid = params['MessageSid'] ?? params['SmsSid'] ?? params['SmsMessageSid'];
    if (messageSid === undefined || messageSid.length === 0)
      throw new InvalidTwilioWebhookError('sms webhook missing MessageSid');
    return { eventId: messageSid, channel, params };
  }

  const callSid = params['CallSid'];
  if (callSid === undefined || callSid.length === 0)
    throw new InvalidTwilioWebhookError(`${channel} webhook missing CallSid`);

  if (channel === 'voice') {
    return { eventId: `${callSid}:voice`, channel, params };
  }

  // channel === 'status': either a recording-status or a call-status callback.
  const recordingSid = params['RecordingSid'];
  const recordingStatus = params['RecordingStatus'];
  if (
    recordingStatus !== undefined &&
    recordingStatus.length > 0 &&
    recordingSid !== undefined &&
    recordingSid.length > 0
  ) {
    return { eventId: `${callSid}:rec:${recordingSid}:${recordingStatus}`, channel, params };
  }
  const callStatus = params['CallStatus'];
  if (callStatus === undefined || callStatus.length === 0)
    throw new InvalidTwilioWebhookError('status webhook missing CallStatus/RecordingStatus');
  const sequence = params['SequenceNumber'] ?? '';
  return { eventId: `${callSid}:call:${callStatus}:${sequence}`, channel, params };
}

/**
 * Ingress signature verifier (CONTRACTS §C2: `verifyWebhook` MUST run on every
 * ingress). A seam so the route verifies without a compile-time branch on the
 * adapter — the composition root binds the real Twilio auth token in production
 * and the mock token under `MOCK_MODE`.
 */
export interface TwilioIngressVerifier {
  verify(headers: Record<string, string>, rawBody: string, url: string): boolean;
}

/** HMAC-SHA1 verifier over Twilio's scheme (the shared `twilio-signature` code). */
export class SignatureTwilioVerifier implements TwilioIngressVerifier {
  private readonly authToken: string;
  constructor(authToken: string) {
    this.authToken = authToken;
  }
  verify(headers: Record<string, string>, rawBody: string, url: string): boolean {
    return verifyTwilioSignature(
      url,
      rawBody,
      readHeader(headers, TWILIO_SIGNATURE_HEADER),
      this.authToken,
    );
  }
}

export interface PersistTwilioResult {
  /** True iff this delivery was newly stored (false ⇒ duplicate provider_event_id). */
  stored: boolean;
  inboxId: string | null;
}

/**
 * Persist a verified Twilio webhook into `webhook_inbox` (unique
 * `(provider, provider_event_id)`). Duplicate deliveries conflict and no-op; the
 * caller fast-200s regardless. The stored `raw` carries everything the worker needs
 * to reprocess without the original request (channel + params + receipt time).
 */
export async function persistTwilioWebhook(
  db: Db,
  parsed: ParsedTwilioWebhook,
  receivedAt: string,
): Promise<PersistTwilioResult> {
  const inserted = await db
    .insert(webhookInbox)
    .values({
      provider: 'twilio',
      providerEventId: parsed.eventId,
      raw: { channel: parsed.channel, params: parsed.params, receivedAt },
    })
    .onConflictDoNothing()
    .returning({ id: webhookInbox.id });
  const row = inserted[0];
  return { stored: row !== undefined, inboxId: row?.id ?? null };
}
