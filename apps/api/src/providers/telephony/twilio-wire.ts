import type {
  CallLifecycleEvent,
  DialOptions,
  InboundSmsEvent,
} from '@switchboard/shared/providers';
import { TWILIO_SIGNATURE_HEADER, signTwilioForm } from './twilio-signature.ts';

/**
 * Twilio wire-format encoders: turn normalized lifecycle / inbound-SMS events into
 * the form-encoded, signed callback payloads Twilio actually POSTs (voice status +
 * recording status callbacks to `/wh/twilio/status`, inbound SMS to
 * `/wh/twilio/sms`). Used by the mock's `emitWebhook` stream and by the recorded
 * fixtures so both exercise the same real signature path (CONTRACTS §C2 verify).
 *
 * Also owns the pure lifecycle *step* builders `dial()` uses when no explicit
 * script is registered — these encode §I-REC structurally (recording steps only
 * behind a consent marker).
 */

export const TWILIO_API_VERSION = '2010-04-01';

/** Fixed mock account SID (34 chars, `AC` + 32) — real mode reads TWILIO_ACCOUNT_SID. */
export const MOCK_ACCOUNT_SID = 'AC00000000000000000000000000000000';

/** Public base the mock signs callback URLs against (matches C7 `/wh/twilio/*`). */
export const DEFAULT_PUBLIC_WEBHOOK_BASE = 'https://switchboard.test';

export interface TwilioCallbackUrls {
  /** Voice + recording status callbacks (C7 `/wh/twilio/status`). */
  voiceStatus: string;
  /** Inbound SMS (C7 `/wh/twilio/sms`). */
  sms: string;
  /** Inbound call TwiML request (C7 `/wh/twilio/voice`). */
  voice: string;
}

export function defaultCallbackUrls(
  base: string = DEFAULT_PUBLIC_WEBHOOK_BASE,
): TwilioCallbackUrls {
  return {
    voiceStatus: `${base}/wh/twilio/status`,
    sms: `${base}/wh/twilio/sms`,
    voice: `${base}/wh/twilio/voice`,
  };
}

/** Twilio REST URL for a recording resource — used as `calls.recording_ref`. */
export function recordingUrl(accountSid: string, recordingSid: string): string {
  return `https://api.twilio.com/${TWILIO_API_VERSION}/Accounts/${accountSid}/Recordings/${recordingSid}`;
}

// ---------------------------------------------------------------------------
// Lifecycle step specs (input to scriptLifecycle / the default builders)
// ---------------------------------------------------------------------------

/**
 * A lightweight lifecycle step: the mock materializes it into a full
 * `CallLifecycleEvent` (filling callSid, sequence, `at`, and any ids the step
 * leaves out). `delayMs` is the gap after the previous step (default 0 → the whole
 * stream is due at dial time; a positive value defers delivery until the injected
 * clock advances).
 */
export type LifecycleStep =
  | {
      type: 'queued' | 'ringing' | 'answered' | 'missed' | 'recording_consent_played';
      delayMs?: number;
    }
  | { type: 'recording_started'; delayMs?: number; recordingSid?: string }
  | {
      type: 'recording_completed';
      delayMs?: number;
      recordingSid?: string;
      recordingRef?: string;
      durationS?: number;
    }
  | { type: 'completed'; delayMs?: number; durationS?: number; voicemailDropped?: boolean }
  | { type: 'failed'; delayMs?: number; reason?: string }
  | { type: 'voicemail'; delayMs?: number; recordingRef?: string; recordingDurationS?: number };

/**
 * Default outbound-dial lifecycle when no explicit script is registered. §I-REC by
 * construction: recording steps are emitted only when BOTH `record` and
 * `consentAnnouncement` are set, and always after the `recording_consent_played`
 * marker; with `record=false` (or no consent) the stream contains no recording
 * steps at all.
 */
export function defaultOutboundSteps(opts: DialOptions): LifecycleStep[] {
  const armRecording = opts.record && opts.consentAnnouncement;
  const steps: LifecycleStep[] = [{ type: 'queued' }, { type: 'ringing' }];
  if (armRecording) steps.push({ type: 'recording_consent_played' });
  steps.push({ type: 'answered' });
  if (armRecording) {
    steps.push({ type: 'recording_started' });
    steps.push({ type: 'recording_completed' });
  }
  steps.push({ type: 'completed' });
  return steps;
}

/** Default inbound call that rang unanswered and left a voicemail (ref + duration). */
export function inboundVoicemailSteps(): LifecycleStep[] {
  return [{ type: 'ringing' }, { type: 'voicemail' }];
}

// ---------------------------------------------------------------------------
// Event → Twilio params
// ---------------------------------------------------------------------------

export interface CallWireContext {
  accountSid: string;
  from: string;
  to: string;
  /** Twilio `Direction`, e.g. `outbound-api` or `inbound`. */
  direction: string;
}

function recordingSidFromRef(ref: string): string {
  const slash = ref.lastIndexOf('/');
  const tail = slash >= 0 ? ref.slice(slash + 1) : ref;
  return tail.length > 0 ? tail : ref;
}

/**
 * Encode a call-lifecycle event as Twilio voice/recording status-callback params,
 * or `null` for `recording_consent_played` (an adapter-internal marker Twilio has
 * no webhook for — it is delivered on the normalized stream without a wire body).
 */
export function callEventToParams(
  event: CallLifecycleEvent,
  ctx: CallWireContext,
): Record<string, string> | null {
  if (event.type === 'recording_consent_played') return null;

  const base: Record<string, string> = {
    AccountSid: ctx.accountSid,
    CallSid: event.callSid,
    From: ctx.from,
    To: ctx.to,
    Direction: ctx.direction,
    ApiVersion: TWILIO_API_VERSION,
    Timestamp: new Date(event.at).toUTCString(),
    SequenceNumber: String(event.sequence),
  };

  switch (event.type) {
    case 'queued':
      return { ...base, CallStatus: 'queued' };
    case 'ringing':
      return { ...base, CallStatus: 'ringing' };
    case 'answered':
      return { ...base, CallStatus: 'in-progress' };
    case 'missed':
      return { ...base, CallStatus: 'no-answer' };
    case 'failed':
      return { ...base, CallStatus: 'failed' };
    case 'completed':
      return { ...base, CallStatus: 'completed', CallDuration: String(event.durationS) };
    case 'recording_started':
      return {
        ...base,
        RecordingSid: event.recordingSid,
        RecordingStatus: 'in-progress',
        RecordingUrl: recordingUrl(ctx.accountSid, event.recordingSid),
      };
    case 'recording_completed':
      return {
        ...base,
        RecordingSid: event.recordingSid,
        RecordingStatus: 'completed',
        RecordingUrl: event.recordingRef,
        RecordingDuration: String(event.durationS),
      };
    case 'voicemail':
      return {
        ...base,
        CallStatus: 'completed',
        AnsweredBy: 'machine_end_beep',
        RecordingSid: recordingSidFromRef(event.recordingRef),
        RecordingUrl: event.recordingRef,
        RecordingDuration: String(event.recordingDurationS),
      };
    default: {
      const unreachable: never = event;
      throw new Error(`unhandled call event ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Encode an inbound SMS as Twilio `/wh/twilio/sms` params. */
export function inboundSmsToParams(
  event: InboundSmsEvent,
  accountSid: string,
): Record<string, string> {
  return {
    AccountSid: accountSid,
    MessageSid: event.messageSid,
    SmsSid: event.messageSid,
    SmsMessageSid: event.messageSid,
    From: event.from,
    To: event.to,
    Body: event.body,
    NumMedia: String(event.numMedia),
    NumSegments: '1',
    ApiVersion: TWILIO_API_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Signed wire payloads / fixture envelopes
// ---------------------------------------------------------------------------

/** A signed, form-encoded Twilio HTTP payload (headers + rawBody + parsed view). */
export interface TwilioWirePayload {
  provider: 'twilio';
  eventId: string;
  url: string;
  headers: Record<string, string>;
  rawBody: string;
  params: Record<string, string>;
}

/**
 * On-disk recorded fixture envelope. Follows the `fixtures/webhooks/README.md`
 * (task 0c) envelope shape and augments it with the two fields a Twilio replay
 * needs that the generic schema omits: `channel` (voice vs sms routing) and `url`
 * — the signed request URL. Twilio signs URL + params, so `verifyWebhook(headers,
 * rawBody, url)` cannot run without the exact URL; carrying it in the envelope
 * makes each fixture self-sufficient for the verify-on-every-ingress rule (§C2).
 */
export interface TwilioFixtureEnvelope {
  provider: 'twilio';
  eventId: string;
  channel: 'voice' | 'sms';
  /** The exact request URL the signature is computed over (Twilio signs URL+params). */
  url: string;
  receivedAt: string;
  headers: Record<string, string>;
  rawBody: string;
  payload: Record<string, string>;
}

/** Deterministically URL-encode params to an `x-www-form-urlencoded` body. */
export function encodeForm(params: Record<string, string>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    usp.append(key, value);
  }
  return usp.toString();
}

/**
 * Build a signed Twilio wire payload: encode the params, sign URL+params with the
 * auth token, and attach the `X-Twilio-Signature` header. The signature is over the
 * decoded params (Twilio's scheme), so `verifyTwilioSignature(url, rawBody, sig)`
 * round-trips exactly.
 */
export function buildSignedWire(
  url: string,
  params: Record<string, string>,
  authToken: string,
  eventId: string,
): TwilioWirePayload {
  const rawBody = encodeForm(params);
  const signature = signTwilioForm(url, params, authToken);
  return {
    provider: 'twilio',
    eventId,
    url,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      [TWILIO_SIGNATURE_HEADER]: signature,
    },
    rawBody,
    params,
  };
}

/** Project a signed wire payload into an on-disk fixture envelope. */
export function toFixtureEnvelope(
  channel: 'voice' | 'sms',
  wire: TwilioWirePayload,
  receivedAt: string,
): TwilioFixtureEnvelope {
  return {
    provider: 'twilio',
    eventId: wire.eventId,
    channel,
    url: wire.url,
    receivedAt,
    headers: wire.headers,
    rawBody: wire.rawBody,
    payload: wire.params,
  };
}
