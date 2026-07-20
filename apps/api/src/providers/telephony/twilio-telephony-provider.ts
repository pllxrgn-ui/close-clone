import { createHmac } from 'node:crypto';
import { fetchWithTimeout } from '../../lib/fetch-with-timeout.ts';
import { z } from 'zod';
import {
  browserCallTokenSchema,
  dialOptionsSchema,
  type BrowserCallToken,
  type DialOptions,
  type DialResult,
  type SmsResult,
  type TelephonyProvider,
} from '@switchboard/shared/providers';
import { TWILIO_SIGNATURE_HEADER, readHeader, verifyTwilioSignature } from './twilio-signature.ts';

/**
 * Real Twilio `TelephonyProvider` (CONTRACTS §C2). This is the production adapter
 * the engine uses when `MOCK_MODE` is off; the mock (task 3a) drives every test of
 * the engine/ingress. This adapter is exercised ONLY by its own unit tests, which
 * inject a synthetic `TwilioTransport` (no network, no Twilio account) — exactly
 * like 2b's `GmailEmailProvider`. REAL-mode wiring against live Twilio is a
 * HUMAN_TODO checkpoint.
 *
 * Design:
 *  - All Twilio REST I/O flows through the injected {@link TwilioTransport} so a
 *    test supplies canned responses; the default `fetch` transport is a thin,
 *    untested-in-CI shell used only in production.
 *  - `createCallToken` mints a Twilio Voice access token (JWT, HS256 over the API
 *    Key secret) by hand — no `twilio` SDK dependency is added (see report).
 *  - `verifyWebhook` reuses the shared `twilio-signature` HMAC-SHA1 verifier — the
 *    SAME code the mock + recorded fixtures sign with, so a fixture verifies here.
 *  - §I-REC is enforced at the adapter line: `dial` REFUSES `record` without a
 *    `consentAnnouncement` (the interface doc: "the adapter never records without
 *    one"). Recording is never armed on a call that has no consent.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const DEFAULT_API_BASE = 'https://api.twilio.com';
const TWILIO_API_VERSION = '2010-04-01';
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

// --- Transport seam ---------------------------------------------------------

export interface TwilioTransportRequest {
  method: 'GET' | 'POST';
  url: string;
  /** `application/x-www-form-urlencoded` params (Twilio REST is form-encoded). */
  form: Record<string, string>;
  headers: Record<string, string>;
}

export interface TwilioTransportResponse {
  status: number;
  /** Raw response body (Twilio returns JSON). */
  body: string;
}

/**
 * The HTTP seam. Tests inject a synthetic implementation returning canned Twilio
 * JSON; production binds {@link FetchTwilioTransport}.
 */
export interface TwilioTransport {
  request(req: TwilioTransportRequest): Promise<TwilioTransportResponse>;
}

/** Thrown when Twilio returns a non-2xx (wrapped by the engine as C8 PROVIDER_ERROR). */
export class TwilioApiError extends Error {
  readonly status: number;
  readonly twilioCode: number | null;
  constructor(status: number, message: string, twilioCode: number | null) {
    super(message);
    this.name = 'TwilioApiError';
    this.status = status;
    this.twilioCode = twilioCode;
  }
}

/** Thrown when `dial` is asked to record without a consent announcement (§I-REC). */
export class RecordingConsentError extends Error {
  constructor() {
    super('refusing to record a call without a consent announcement (§I-REC)');
    this.name = 'RecordingConsentError';
  }
}

/** Thrown when a Voice-token mint is requested but the API-key config is absent. */
export class TokenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenConfigError';
  }
}

// --- Config -----------------------------------------------------------------

export interface TwilioTelephonyConfig {
  accountSid: string;
  /** Auth token — HMAC key for `verifyWebhook` AND Basic-auth fallback for REST. */
  authToken: string;
  transport: TwilioTransport;
  /** Standard-key SID used as REST Basic-auth username + Voice-token issuer. */
  apiKeySid?: string;
  /** Standard-key secret — the HS256 signing key for the Voice access token. */
  apiKeySecret?: string;
  /** Outgoing TwiML application SID embedded in the Voice grant. */
  twimlAppSid?: string;
  /** TwiML URL for outbound `dial` (Twilio fetches it to drive the call). */
  voiceUrl?: string;
  /** Voice/recording status callback URL (C7 `/wh/twilio/status`). */
  statusCallbackUrl?: string;
  /** SMS status callback URL (C7 `/wh/twilio/status`). */
  smsStatusCallbackUrl?: string;
  apiBase?: string;
  tokenTtlSeconds?: number;
  now?: () => Date;
}

// --- Twilio response shapes (only the fields we consume) --------------------

const callResourceSchema = z.object({ sid: z.string().min(1) });
const messageResourceSchema = z.object({ sid: z.string().min(1) });
const twilioErrorSchema = z.object({
  message: z.string().optional(),
  code: z.number().optional(),
});

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Adapter ----------------------------------------------------------------

export class TwilioTelephonyProvider implements TelephonyProvider {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly transport: TwilioTransport;
  private readonly apiKeySid: string | undefined;
  private readonly apiKeySecret: string | undefined;
  private readonly twimlAppSid: string | undefined;
  private readonly voiceUrl: string | undefined;
  private readonly statusCallbackUrl: string | undefined;
  private readonly smsStatusCallbackUrl: string | undefined;
  private readonly apiBase: string;
  private readonly tokenTtlSeconds: number;
  private readonly now: () => Date;

  constructor(config: TwilioTelephonyConfig) {
    if (config.accountSid.length === 0) throw new Error('twilio: accountSid is required');
    if (config.authToken.length === 0) throw new Error('twilio: authToken is required');
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.transport = config.transport;
    this.apiKeySid = config.apiKeySid;
    this.apiKeySecret = config.apiKeySecret;
    this.twimlAppSid = config.twimlAppSid;
    this.voiceUrl = config.voiceUrl;
    this.statusCallbackUrl = config.statusCallbackUrl;
    this.smsStatusCallbackUrl = config.smsStatusCallbackUrl;
    this.apiBase = config.apiBase ?? DEFAULT_API_BASE;
    this.tokenTtlSeconds = config.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    this.now = config.now ?? ((): Date => new Date());
  }

  // --- TelephonyProvider (CONTRACTS §C2) -----------------------------------

  async createCallToken(userId: string): Promise<BrowserCallToken> {
    if (userId.length === 0) throw new Error('twilio createCallToken: empty userId');
    if (
      this.apiKeySid === undefined ||
      this.apiKeySecret === undefined ||
      this.twimlAppSid === undefined
    ) {
      throw new TokenConfigError(
        'twilio Voice token requires apiKeySid, apiKeySecret and twimlAppSid',
      );
    }
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const expiresAtSeconds = issuedAt + this.tokenTtlSeconds;
    const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
    const payload = {
      jti: `${this.apiKeySid}-${issuedAt}`,
      iss: this.apiKeySid,
      sub: this.accountSid,
      iat: issuedAt,
      exp: expiresAtSeconds,
      grants: {
        identity: userId,
        voice: {
          incoming: { allow: true },
          outgoing: { application_sid: this.twimlAppSid },
        },
      },
    };
    const signingInput = `${base64Url(Buffer.from(JSON.stringify(header)))}.${base64Url(
      Buffer.from(JSON.stringify(payload)),
    )}`;
    const signature = base64Url(
      createHmac('sha256', this.apiKeySecret).update(signingInput).digest(),
    );
    return browserCallTokenSchema.parse({
      token: `${signingInput}.${signature}`,
      identity: userId,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      ttlSeconds: this.tokenTtlSeconds,
    });
  }

  async dial(from: string, to: string, opts: DialOptions): Promise<DialResult> {
    const parsedOpts = dialOptionsSchema.parse(opts);
    if (from.length === 0 || to.length === 0)
      throw new Error('twilio dial: from and to are required');
    // §I-REC (adapter line): never record without a consent announcement.
    if (parsedOpts.record && !parsedOpts.consentAnnouncement) throw new RecordingConsentError();

    const form: Record<string, string> = {
      To: to,
      From: from,
      StatusCallbackMethod: 'POST',
    };
    if (this.voiceUrl !== undefined) form.Url = this.voiceUrl;
    if (this.statusCallbackUrl !== undefined) {
      form.StatusCallback = this.statusCallbackUrl;
      form.StatusCallbackEvent = 'initiated ringing answered completed';
    }
    if (parsedOpts.record) {
      form.Record = 'true';
      if (this.statusCallbackUrl !== undefined) {
        form.RecordingStatusCallback = this.statusCallbackUrl;
        form.RecordingStatusCallbackEvent = 'in-progress completed';
      }
    }
    const body = await this.post(`${this.accountPath()}/Calls.json`, form);
    const call = callResourceSchema.parse(JSON.parse(body));
    return { callSid: call.sid };
  }

  async sendSms(
    from: string,
    to: string,
    body: string,
    idempotencyKey: string,
  ): Promise<SmsResult> {
    if (from.length === 0 || to.length === 0)
      throw new Error('twilio sendSms: from and to are required');
    if (idempotencyKey.length === 0) throw new Error('twilio sendSms: empty idempotency key');
    const form: Record<string, string> = { To: to, From: from, Body: body };
    if (this.smsStatusCallbackUrl !== undefined) form.StatusCallback = this.smsStatusCallbackUrl;
    // Twilio honours an `Idempotency-Key` header on message create; passing the
    // engine's key makes a network retry safe even before the SENT row commits.
    const respBody = await this.post(`${this.accountPath()}/Messages.json`, form, {
      'Idempotency-Key': idempotencyKey,
    });
    const message = messageResourceSchema.parse(JSON.parse(respBody));
    return { sid: message.sid };
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
    if (callSid.length === 0) throw new Error('twilio dropVoicemail: empty callSid');
    if (recordingRef.length === 0) throw new Error('twilio dropVoicemail: empty recordingRef');
    // Redirect the live call to play the rep's pre-recorded message, then hang up.
    // The rep's own asset is never a consent-gated conversation recording (§I-REC).
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${escapeXml(
      recordingRef,
    )}</Play><Hangup/></Response>`;
    await this.post(`${this.accountPath()}/Calls/${encodeURIComponent(callSid)}.json`, {
      Twiml: twiml,
    });
  }

  // --- internals -----------------------------------------------------------

  private accountPath(): string {
    return `${this.apiBase}/${TWILIO_API_VERSION}/Accounts/${this.accountSid}`;
  }

  private authorizationHeader(): string {
    const user = this.apiKeySid ?? this.accountSid;
    const pass = this.apiKeySid !== undefined ? (this.apiKeySecret ?? '') : this.authToken;
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }

  private async post(
    url: string,
    form: Record<string, string>,
    extraHeaders: Record<string, string> = {},
  ): Promise<string> {
    const res = await this.transport.request({
      method: 'POST',
      url,
      form,
      headers: {
        Authorization: this.authorizationHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        ...extraHeaders,
      },
    });
    if (res.status < 200 || res.status >= 300) {
      let message = `twilio POST ${url} failed with status ${res.status}`;
      let code: number | null = null;
      try {
        const parsed = twilioErrorSchema.parse(JSON.parse(res.body));
        if (parsed.message !== undefined) message = parsed.message;
        if (parsed.code !== undefined) code = parsed.code;
      } catch {
        // Non-JSON error body — keep the generic message.
      }
      throw new TwilioApiError(res.status, message, code);
    }
    return res.body;
  }
}

/** Minimal XML text escaper for the voicemail TwiML `<Play>` node. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Production HTTP transport over global `fetch`. Never exercised by the unit
 * suite (tests inject a synthetic transport); it exists so the composition root
 * can bind a real adapter. Encodes the form body and returns the raw text.
 */
export class FetchTwilioTransport implements TwilioTransport {
  async request(req: TwilioTransportRequest): Promise<TwilioTransportResponse> {
    const encoded = new URLSearchParams();
    for (const [key, value] of Object.entries(req.form)) encoded.append(key, value);
    const init: RequestInit = { method: req.method, headers: req.headers };
    if (req.method === 'POST') init.body = encoded.toString();
    const res = await fetchWithTimeout(req.url, init);
    return { status: res.status, body: await res.text() };
  }
}

/** Factory the composition root binds when `MOCK_MODE` is off (real Twilio). */
export function createTwilioTelephonyProvider(
  config: TwilioTelephonyConfig,
): TwilioTelephonyProvider {
  return new TwilioTelephonyProvider(config);
}
