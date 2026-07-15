import {
  browserCallTokenSchema,
  dialOptionsSchema,
  inboundSmsEventSchema,
  type BrowserCallToken,
  type CallLifecycleEvent,
  type DialOptions,
  type DialResult,
  type InboundSmsEvent,
  type SmsResult,
  type TelephonyProvider,
  type VoicemailDrop,
} from '@switchboard/shared/providers';
import { ManualClock, SequentialIds, type Clock, type IdSource } from '../mock/clock.ts';
import {
  MOCK_TWILIO_AUTH_TOKEN,
  TWILIO_SIGNATURE_HEADER,
  readHeader,
  verifyTwilioSignature,
} from './twilio-signature.ts';
import {
  MOCK_ACCOUNT_SID,
  buildSignedWire,
  callEventToParams,
  defaultCallbackUrls,
  defaultOutboundSteps,
  inboundSmsToParams,
  recordingUrl,
  type CallWireContext,
  type LifecycleStep,
  type TwilioCallbackUrls,
  type TwilioWirePayload,
} from './twilio-wire.ts';

/**
 * In-memory `TelephonyProvider` (CONTRACTS §C2) for MOCK_MODE and the telephony
 * property/ingress suites. Twilio-shaped, deterministic, and driven by an injected
 * clock + id source (no `Date.now()`/`Math.random()` in behaviour, so a scripted
 * stream replays byte-identically).
 *
 * Test instruments:
 *  - `scriptLifecycle(callSid, steps)` scripts the webhook stream a `dial()` (or
 *    inbound injection) will emit; `peekNextCallSid()` predicts the next callSid so
 *    a script can be registered before dialling.
 *  - `dial()` with no script synthesises a stream from `{record, consentAnnouncement}`.
 *    §I-REC is structural: recording events appear only when BOTH flags are set and
 *    always after a `recording_consent_played` marker; `record=false` streams carry
 *    no recording refs (assert via `lifecycleFor(callSid)`).
 *  - `emitWebhook(handler)` subscribes to the delivered stream; `pump()` releases
 *    every event now due per the injected clock (no real timers). Each delivered
 *    webhook carries the normalized event plus, for events Twilio actually POSTs, a
 *    signed `X-Twilio-Signature` wire body that `verifyWebhook` accepts.
 *  - `sendSms` is idempotent on `idempotencyKey` (same key ⇒ same sid, one logical
 *    send) and counts raw calls; `dial`/`dropVoicemail`/`createCallToken` count too
 *    (I-DNC/I-QUIET are asserted by the engine via these counters).
 */

const DEFAULT_TOKEN_TTL_MS = 3_600_000;
const DEFAULT_CALL_DURATION_S = 42;
const DEFAULT_TALK_DURATION_S = 37;
const DEFAULT_VOICEMAIL_DURATION_S = 18;

/** A webhook delivered to an `emitWebhook` subscriber. */
export interface EmittedTelephonyWebhook {
  channel: 'voice' | 'sms';
  event: CallLifecycleEvent | InboundSmsEvent;
  receivedAt: string;
  /** Signed Twilio HTTP body — absent only for the `recording_consent_played`
   *  marker, which Twilio has no webhook for. */
  wire?: TwilioWirePayload;
}

export type TelephonyWebhookHandler = (webhook: EmittedTelephonyWebhook) => void;

/** Fires on every `sendSms` entry (before the idempotency short-circuit) so a test
 *  can land a suppression/opt-out during the send window (I-QUIET race scripting). */
export type SmsSendInterceptor = (
  idempotencyKey: string,
  sms: { from: string; to: string; body: string },
) => void;

export interface MockTelephonyProviderOptions {
  clock?: Clock;
  ids?: IdSource;
  /** HMAC key for `verifyWebhook` and emitted-wire signing. */
  authToken?: string;
  accountSid?: string;
  /** Base URL callbacks are signed against (default `https://switchboard.test`). */
  publicWebhookBase?: string;
  callbackUrls?: TwilioCallbackUrls;
  tokenTtlMs?: number;
  defaultCallDurationS?: number;
  defaultTalkDurationS?: number;
  defaultVoicemailDurationS?: number;
}

interface QueuedWebhook {
  dueAt: number;
  enqueueIndex: number;
  channel: 'voice' | 'sms';
  event: CallLifecycleEvent | InboundSmsEvent;
  wire: TwilioWirePayload | undefined;
}

interface CallRecord {
  callSid: string;
  direction: string;
  from: string;
  to: string;
}

interface OutboundSmsRecord {
  sid: string;
  from: string;
  to: string;
  body: string;
  sentAt: string;
}

export class MockTelephonyProvider implements TelephonyProvider {
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly authToken: string;
  private readonly accountSid: string;
  private readonly callbackUrls: TwilioCallbackUrls;
  private readonly tokenTtlMs: number;
  private readonly defaultCallDurationS: number;
  private readonly defaultTalkDurationS: number;
  private readonly defaultVoicemailDurationS: number;

  private readonly scripts = new Map<string, LifecycleStep[]>();
  private readonly calls = new Map<string, CallRecord>();
  private readonly emittedByCall = new Map<string, CallLifecycleEvent[]>();
  private readonly nextSeqByCall = new Map<string, number>();
  private readonly lastRecordingSidByCall = new Map<string, string>();

  private queue: QueuedWebhook[] = [];
  private enqueueCounter = 0;
  private readonly handlers = new Set<TelephonyWebhookHandler>();
  private peekedCallSid: string | undefined;

  private dialCalls = 0;
  private createCallTokenCalls = 0;
  private dropVoicemailCalls = 0;
  private totalSmsSendCalls = 0;
  private readonly smsSendCallsByKey = new Map<string, number>();
  private readonly smsLedger = new Map<string, SmsResult>();
  private readonly outboundSms: OutboundSmsRecord[] = [];
  private readonly voicemailDrops: VoicemailDrop[] = [];
  private smsSendInterceptor: SmsSendInterceptor | undefined;

  constructor(options: MockTelephonyProviderOptions = {}) {
    this.clock = options.clock ?? new ManualClock();
    this.ids = options.ids ?? new SequentialIds();
    this.authToken = options.authToken ?? MOCK_TWILIO_AUTH_TOKEN;
    this.accountSid = options.accountSid ?? MOCK_ACCOUNT_SID;
    this.callbackUrls = options.callbackUrls ?? defaultCallbackUrls(options.publicWebhookBase);
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.defaultCallDurationS = options.defaultCallDurationS ?? DEFAULT_CALL_DURATION_S;
    this.defaultTalkDurationS = options.defaultTalkDurationS ?? DEFAULT_TALK_DURATION_S;
    this.defaultVoicemailDurationS =
      options.defaultVoicemailDurationS ?? DEFAULT_VOICEMAIL_DURATION_S;
  }

  // --- TelephonyProvider (CONTRACTS §C2) -----------------------------------

  async createCallToken(userId: string): Promise<BrowserCallToken> {
    if (userId.length === 0) throw new Error('mock createCallToken: empty userId');
    this.createCallTokenCalls += 1;
    const expiresAt = new Date(this.clock.now().getTime() + this.tokenTtlMs).toISOString();
    return browserCallTokenSchema.parse({
      token: `mock-call-token-${userId}-${this.ids.next('calltoken')}`,
      identity: userId,
      expiresAt,
      ttlSeconds: Math.floor(this.tokenTtlMs / 1000),
    });
  }

  async dial(from: string, to: string, opts: DialOptions): Promise<DialResult> {
    const parsedOpts = dialOptionsSchema.parse(opts);
    if (from.length === 0 || to.length === 0)
      throw new Error('mock dial: from and to are required');
    this.dialCalls += 1;

    const callSid = this.takeCallSid();
    const steps = this.scripts.get(callSid) ?? defaultOutboundSteps(parsedOpts);
    this.calls.set(callSid, { callSid, direction: 'outbound-api', from, to });
    this.enqueueLifecycle(callSid, steps, {
      accountSid: this.accountSid,
      from,
      to,
      direction: 'outbound-api',
    });
    return { callSid };
  }

  async sendSms(
    from: string,
    to: string,
    body: string,
    idempotencyKey: string,
  ): Promise<SmsResult> {
    if (from.length === 0 || to.length === 0)
      throw new Error('mock sendSms: from and to are required');
    if (idempotencyKey.length === 0) throw new Error('mock sendSms: empty idempotency key');

    // Count every raw call (I-QUIET/I-DNC: engine asserts "provider not called").
    this.totalSmsSendCalls += 1;
    this.smsSendCallsByKey.set(
      idempotencyKey,
      (this.smsSendCallsByKey.get(idempotencyKey) ?? 0) + 1,
    );
    this.smsSendInterceptor?.(idempotencyKey, { from, to, body });

    const prior = this.smsLedger.get(idempotencyKey);
    if (prior !== undefined) return prior; // idempotent: one logical send, same sid

    const result: SmsResult = { sid: this.nextSmsSid() };
    this.smsLedger.set(idempotencyKey, result);
    this.outboundSms.push({ sid: result.sid, from, to, body, sentAt: this.nowIso() });
    return result;
  }

  verifyWebhook(headers: Record<string, string>, rawBody: string, url: string): boolean {
    return verifyTwilioSignature(
      url,
      rawBody,
      readHeader(headers, TWILIO_SIGNATURE_HEADER),
      this.authToken,
    );
  }

  async dropVoicemail(callSid: string, recordingRef: string): Promise<void> {
    if (recordingRef.length === 0) throw new Error('mock dropVoicemail: empty recordingRef');
    const call = this.calls.get(callSid);
    if (call === undefined) throw new Error(`mock dropVoicemail: unknown callSid ${callSid}`);
    this.dropVoicemailCalls += 1;
    this.voicemailDrops.push({ callSid, recordingRef, at: this.nowIso() });
    // Reflect the drop as the call's terminal event so the timeline records it.
    this.enqueueLifecycle(callSid, [{ type: 'completed', voicemailDropped: true }], {
      accountSid: this.accountSid,
      from: call.from,
      to: call.to,
      direction: call.direction,
    });
  }

  // --- Scripting hooks (CONTRACTS §C2 mock hooks) --------------------------

  /**
   * Script the exact lifecycle a `dial()` (or `injectInboundCall`) for `callSid`
   * will emit. Register before dialling using `peekNextCallSid()` for the callSid.
   */
  scriptLifecycle(callSid: string, steps: LifecycleStep[]): void {
    this.scripts.set(callSid, [...steps]);
  }

  /** The callSid the next unscripted `dial()` will allocate (does not consume it). */
  peekNextCallSid(): string {
    if (this.peekedCallSid === undefined) this.peekedCallSid = this.nextCallSid();
    return this.peekedCallSid;
  }

  /**
   * Inject an inbound call with an explicit lifecycle (inbound calls are not
   * produced by `dial`). Use `inboundVoicemailSteps()` for the owner→ring-group→
   * voicemail-to-recording default (3c/3d consume the voicemail recording ref).
   */
  injectInboundCall(input: {
    from: string;
    to: string;
    steps: LifecycleStep[];
    callSid?: string;
  }): { callSid: string } {
    const callSid = input.callSid ?? this.nextCallSid();
    this.calls.set(callSid, { callSid, direction: 'inbound', from: input.from, to: input.to });
    this.enqueueLifecycle(callSid, input.steps, {
      accountSid: this.accountSid,
      from: input.from,
      to: input.to,
      direction: 'inbound',
    });
    return { callSid };
  }

  /**
   * Inject an inbound SMS (Twilio `/wh/twilio/sms`). A STOP/UNSUBSCRIBE/QUIT/
   * CANCEL/END body is delivered verbatim; the engine classifies it via
   * `matchOptOutKeyword` (I-QUIET). Delivered on the next `pump()`.
   */
  injectInboundSms(input: {
    from: string;
    to: string;
    body: string;
    numMedia?: number;
    delayMs?: number;
    messageSid?: string;
  }): { messageSid: string } {
    const messageSid = input.messageSid ?? this.nextSmsSid();
    const delayMs = input.delayMs ?? 0;
    const dueAt = this.clock.now().getTime() + delayMs;
    const event: InboundSmsEvent = inboundSmsEventSchema.parse({
      messageSid,
      from: input.from,
      to: input.to,
      body: input.body,
      numMedia: input.numMedia ?? 0,
      receivedAt: new Date(dueAt).toISOString(),
    });
    const params = inboundSmsToParams(event, this.accountSid);
    const wire = buildSignedWire(this.callbackUrls.sms, params, this.authToken, messageSid);
    this.queue.push({
      dueAt,
      enqueueIndex: this.enqueueCounter++,
      channel: 'sms',
      event,
      wire,
    });
    return { messageSid };
  }

  /** Register a hook fired on every `sendSms` entry (I-QUIET race scripting). */
  setSmsSendInterceptor(interceptor: SmsSendInterceptor | undefined): void {
    this.smsSendInterceptor = interceptor;
  }

  // --- Webhook delivery ----------------------------------------------------

  /** Subscribe to the delivered webhook stream; returns an unsubscribe fn. */
  emitWebhook(handler: TelephonyWebhookHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Release every queued webhook now due per the injected clock (dueAt ≤ now), in
   * `(dueAt, enqueue-order)` order, to all subscribers. Returns the delivered
   * webhooks. Advance the clock between pumps to release time-gated events.
   */
  pump(): EmittedTelephonyWebhook[] {
    const now = this.clock.now().getTime();
    const due = this.queue
      .filter((q) => q.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt || a.enqueueIndex - b.enqueueIndex);
    this.queue = this.queue.filter((q) => q.dueAt > now);

    const delivered: EmittedTelephonyWebhook[] = [];
    for (const q of due) {
      const webhook: EmittedTelephonyWebhook = {
        channel: q.channel,
        event: q.event,
        receivedAt: new Date(q.dueAt).toISOString(),
        ...(q.wire !== undefined ? { wire: q.wire } : {}),
      };
      for (const handler of this.handlers) handler(webhook);
      delivered.push(webhook);
    }
    return delivered;
  }

  // --- Inspection (property/ingress-suite affordances) ---------------------

  /** The full normalized lifecycle for a call (incl. the consent marker), whether
   *  or not it has been pumped — the surface I-REC assertions read. */
  lifecycleFor(callSid: string): CallLifecycleEvent[] {
    return [...(this.emittedByCall.get(callSid) ?? [])];
  }

  /** Webhooks queued but not yet delivered (time-gated or un-pumped). */
  get pendingWebhookCount(): number {
    return this.queue.length;
  }

  get dialCount(): number {
    return this.dialCalls;
  }

  get createCallTokenCount(): number {
    return this.createCallTokenCalls;
  }

  get dropVoicemailCount(): number {
    return this.dropVoicemailCalls;
  }

  /** Total raw `sendSms` invocations (all keys). */
  get sendSmsCount(): number {
    return this.totalSmsSendCalls;
  }

  /** Raw `sendSms` invocations for one idempotency key. */
  sendSmsCountForKey(key: string): number {
    return this.smsSendCallsByKey.get(key) ?? 0;
  }

  /** Distinct logical SMS sends (idempotency dedupe applied). */
  get deliveredSmsCount(): number {
    return this.smsLedger.size;
  }

  getVoicemailDrops(): VoicemailDrop[] {
    return [...this.voicemailDrops];
  }

  getOutboundSms(): OutboundSmsRecord[] {
    return this.outboundSms.map((s) => ({ ...s }));
  }

  // --- internals -----------------------------------------------------------

  private enqueueLifecycle(
    callSid: string,
    steps: LifecycleStep[],
    ctx: CallWireContext,
  ): CallLifecycleEvent[] {
    const startMs = this.clock.now().getTime();
    let seq = this.nextSeqByCall.get(callSid) ?? 0;
    let cumulativeDelay = 0;
    let lastRecordingSid = this.lastRecordingSidByCall.get(callSid);
    const events: CallLifecycleEvent[] = [];

    for (const step of steps) {
      cumulativeDelay += step.delayMs ?? 0;
      const at = new Date(startMs + cumulativeDelay).toISOString();
      const materialized = this.materializeStep(step, callSid, seq, at, lastRecordingSid);
      if (materialized.recordingSid !== undefined) lastRecordingSid = materialized.recordingSid;
      seq += 1;

      const params = callEventToParams(materialized.event, ctx);
      this.queue.push({
        dueAt: startMs + cumulativeDelay,
        enqueueIndex: this.enqueueCounter++,
        channel: 'voice',
        event: materialized.event,
        wire:
          params === null
            ? undefined
            : buildSignedWire(
                this.callbackUrls.voiceStatus,
                params,
                this.authToken,
                `${callSid}-${materialized.event.sequence}-${materialized.event.type}`,
              ),
      });
      events.push(materialized.event);
    }

    this.nextSeqByCall.set(callSid, seq);
    if (lastRecordingSid !== undefined) this.lastRecordingSidByCall.set(callSid, lastRecordingSid);
    this.emittedByCall.set(callSid, [...(this.emittedByCall.get(callSid) ?? []), ...events]);
    return events;
  }

  private materializeStep(
    step: LifecycleStep,
    callSid: string,
    sequence: number,
    at: string,
    lastRecordingSid: string | undefined,
  ): { event: CallLifecycleEvent; recordingSid?: string } {
    switch (step.type) {
      case 'queued':
        return { event: { type: 'queued', callSid, sequence, at } };
      case 'ringing':
        return { event: { type: 'ringing', callSid, sequence, at } };
      case 'recording_consent_played':
        return { event: { type: 'recording_consent_played', callSid, sequence, at } };
      case 'answered':
        return { event: { type: 'answered', callSid, sequence, at } };
      case 'missed':
        return { event: { type: 'missed', callSid, sequence, at } };
      case 'failed':
        return {
          event: { type: 'failed', callSid, sequence, at, reason: step.reason ?? 'failed' },
        };
      case 'completed':
        return {
          event: {
            type: 'completed',
            callSid,
            sequence,
            at,
            durationS: step.durationS ?? this.defaultCallDurationS,
            voicemailDropped: step.voicemailDropped ?? false,
          },
        };
      case 'recording_started': {
        const recordingSid = step.recordingSid ?? this.nextRecordingSid();
        return {
          event: { type: 'recording_started', callSid, sequence, at, recordingSid },
          recordingSid,
        };
      }
      case 'recording_completed': {
        const recordingSid = step.recordingSid ?? lastRecordingSid ?? this.nextRecordingSid();
        return {
          event: {
            type: 'recording_completed',
            callSid,
            sequence,
            at,
            recordingSid,
            recordingRef: step.recordingRef ?? recordingUrl(this.accountSid, recordingSid),
            durationS: step.durationS ?? this.defaultTalkDurationS,
          },
          recordingSid,
        };
      }
      case 'voicemail': {
        const recordingSid = this.nextRecordingSid();
        return {
          event: {
            type: 'voicemail',
            callSid,
            sequence,
            at,
            recordingRef: step.recordingRef ?? recordingUrl(this.accountSid, recordingSid),
            recordingDurationS: step.recordingDurationS ?? this.defaultVoicemailDurationS,
          },
        };
      }
      default: {
        const unreachable: never = step;
        throw new Error(`mock: unhandled lifecycle step ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private takeCallSid(): string {
    if (this.peekedCallSid !== undefined) {
      const sid = this.peekedCallSid;
      this.peekedCallSid = undefined;
      return sid;
    }
    return this.nextCallSid();
  }

  private nextCallSid(): string {
    return formatSid('CA', this.ids.next('call'));
  }

  private nextSmsSid(): string {
    return formatSid('SM', this.ids.next('sms'));
  }

  private nextRecordingSid(): string {
    return formatSid('RE', this.ids.next('recording'));
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}

/** Format a deterministic, Twilio-shaped 34-char SID from an id-source value. */
function formatSid(prefix: string, raw: string): string {
  const dash = raw.lastIndexOf('-');
  const suffix = dash >= 0 ? raw.slice(dash + 1) : raw;
  return prefix + suffix.padStart(32, '0');
}

/** Factory the composition root binds under `MOCK_MODE=1` (see README wiring). */
export function createMockTelephonyProvider(
  options: MockTelephonyProviderOptions = {},
): MockTelephonyProvider {
  return new MockTelephonyProvider(options);
}
