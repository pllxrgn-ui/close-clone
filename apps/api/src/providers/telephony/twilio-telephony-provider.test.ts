import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { ManualClock } from '../mock/clock.ts';
import { buildSignedWire, callEventToParams, MOCK_ACCOUNT_SID } from './twilio-wire.ts';
import { MOCK_TWILIO_AUTH_TOKEN } from './twilio-signature.ts';
import {
  FetchTwilioTransport,
  RecordingConsentError,
  TokenConfigError,
  TwilioApiError,
  TwilioTelephonyProvider,
  createTwilioTelephonyProvider,
  type TwilioTransport,
  type TwilioTransportRequest,
  type TwilioTransportResponse,
} from './twilio-telephony-provider.ts';

/**
 * Unit suite for the real Twilio adapter (task 3b). A synthetic `TwilioTransport`
 * records every request and returns canned Twilio JSON — NO network, no account.
 * Asserts the wire shape (Calls/Messages params, recording flags, Voice-token
 * JWT), the §I-REC adapter guard, and that `verifyWebhook` accepts the same signed
 * payloads the mock/fixtures produce.
 */

interface Recorded {
  requests: TwilioTransportRequest[];
}

function scriptedTransport(responder: (req: TwilioTransportRequest) => TwilioTransportResponse): {
  transport: TwilioTransport;
  recorded: Recorded;
} {
  const recorded: Recorded = { requests: [] };
  const transport: TwilioTransport = {
    request(req: TwilioTransportRequest): Promise<TwilioTransportResponse> {
      recorded.requests.push(req);
      return Promise.resolve(responder(req));
    },
  };
  return { transport, recorded };
}

const ok = (body: unknown): TwilioTransportResponse => ({
  status: 201,
  body: JSON.stringify(body),
});

const REP = '+15617770123';
const LEAD = '+13055550147';

function makeProvider(
  responder: (req: TwilioTransportRequest) => TwilioTransportResponse,
  overrides: Partial<Parameters<typeof createTwilioTelephonyProvider>[0]> = {},
): { provider: TwilioTelephonyProvider; recorded: Recorded } {
  const { transport, recorded } = scriptedTransport(responder);
  const provider = createTwilioTelephonyProvider({
    accountSid: MOCK_ACCOUNT_SID,
    authToken: MOCK_TWILIO_AUTH_TOKEN,
    transport,
    apiKeySid: 'SK00000000000000000000000000000000',
    apiKeySecret: 'super-secret-key',
    twimlAppSid: 'AP00000000000000000000000000000000',
    voiceUrl: 'https://switchboard.test/wh/twilio/voice',
    statusCallbackUrl: 'https://switchboard.test/wh/twilio/status',
    smsStatusCallbackUrl: 'https://switchboard.test/wh/twilio/status',
    now: () => new ManualClock('2026-07-15T12:00:00.000Z').now(),
    ...overrides,
  });
  return { provider, recorded };
}

function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
} {
  const parts = token.split('.');
  const header = parts[0] ?? '';
  const payload = parts[1] ?? '';
  const signature = parts[2] ?? '';
  const decode = (seg: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  return {
    header: decode(header),
    payload: decode(payload),
    signingInput: `${header}.${payload}`,
    signature,
  };
}

describe('createCallToken', () => {
  test('mints a Voice JWT with the right grants and a verifiable HS256 signature', async () => {
    const { provider } = makeProvider(() => ok({ sid: 'CA1' }));
    const token = await provider.createCallToken('user-42');

    expect(token.identity).toBe('user-42');
    expect(token.ttlSeconds).toBe(3600);
    expect(token.expiresAt).toBe('2026-07-15T13:00:00.000Z');

    const { header, payload, signingInput, signature } = decodeJwt(token.token);
    expect(header).toMatchObject({ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' });
    expect(payload['iss']).toBe('SK00000000000000000000000000000000');
    expect(payload['sub']).toBe(MOCK_ACCOUNT_SID);
    const grants = payload['grants'] as Record<string, unknown>;
    expect(grants['identity']).toBe('user-42');
    const voice = grants['voice'] as Record<string, unknown>;
    expect(voice['incoming']).toEqual({ allow: true });
    expect(voice['outgoing']).toEqual({ application_sid: 'AP00000000000000000000000000000000' });

    const expected = createHmac('sha256', 'super-secret-key')
      .update(signingInput)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(signature).toBe(expected);
  });

  test('throws TokenConfigError when the API-key config is absent', async () => {
    const { transport } = scriptedTransport(() => ok({ sid: 'CA1' }));
    const provider = createTwilioTelephonyProvider({
      accountSid: MOCK_ACCOUNT_SID,
      authToken: MOCK_TWILIO_AUTH_TOKEN,
      transport,
    });
    await expect(provider.createCallToken('u1')).rejects.toBeInstanceOf(TokenConfigError);
  });

  test('rejects an empty userId', async () => {
    const { provider } = makeProvider(() => ok({ sid: 'CA1' }));
    await expect(provider.createCallToken('')).rejects.toThrow(/empty userId/);
  });
});

describe('dial', () => {
  test('posts to Calls.json with recording armed when record + consent', async () => {
    const { provider, recorded } = makeProvider(() => ok({ sid: 'CA-DIAL-1' }));
    const res = await provider.dial(REP, LEAD, { record: true, consentAnnouncement: true });
    expect(res.callSid).toBe('CA-DIAL-1');

    const req = recorded.requests[0];
    expect(req).toBeDefined();
    expect(req?.method).toBe('POST');
    expect(req?.url).toContain(`/Accounts/${MOCK_ACCOUNT_SID}/Calls.json`);
    expect(req?.form).toMatchObject({
      To: LEAD,
      From: REP,
      Url: 'https://switchboard.test/wh/twilio/voice',
      Record: 'true',
      RecordingStatusCallback: 'https://switchboard.test/wh/twilio/status',
    });
    expect(req?.headers['Authorization']).toMatch(/^Basic /);
  });

  test('omits recording params when record=false', async () => {
    const { provider, recorded } = makeProvider(() => ok({ sid: 'CA-DIAL-2' }));
    await provider.dial(REP, LEAD, { record: false, consentAnnouncement: false });
    const req = recorded.requests[0];
    expect(req?.form['Record']).toBeUndefined();
    expect(req?.form['RecordingStatusCallback']).toBeUndefined();
  });

  test('§I-REC: refuses to record without a consent announcement and never calls Twilio', async () => {
    const { provider, recorded } = makeProvider(() => ok({ sid: 'CA-DIAL-3' }));
    await expect(
      provider.dial(REP, LEAD, { record: true, consentAnnouncement: false }),
    ).rejects.toBeInstanceOf(RecordingConsentError);
    expect(recorded.requests).toHaveLength(0);
  });

  test('wraps a Twilio non-2xx as TwilioApiError with the provider message/code', async () => {
    const { provider } = makeProvider(() => ({
      status: 400,
      body: JSON.stringify({ message: 'Invalid To number', code: 21211 }),
    }));
    const err = await provider
      .dial(REP, 'not-a-number', { record: false, consentAnnouncement: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TwilioApiError);
    expect(err).toMatchObject({ status: 400, twilioCode: 21211 });
  });
});

describe('sendSms', () => {
  test('posts to Messages.json with an Idempotency-Key header and returns the sid', async () => {
    const { provider, recorded } = makeProvider(() => ok({ sid: 'SM-1' }));
    const res = await provider.sendSms(REP, LEAD, 'hello', 'idem-key-1');
    expect(res.sid).toBe('SM-1');
    const req = recorded.requests[0];
    expect(req?.url).toContain('/Messages.json');
    expect(req?.form).toMatchObject({ To: LEAD, From: REP, Body: 'hello' });
    expect(req?.headers['Idempotency-Key']).toBe('idem-key-1');
  });

  test('rejects an empty idempotency key', async () => {
    const { provider } = makeProvider(() => ok({ sid: 'SM-1' }));
    await expect(provider.sendSms(REP, LEAD, 'hi', '')).rejects.toThrow(/idempotency/);
  });
});

describe('verifyWebhook', () => {
  test('accepts a payload signed with the adapter auth token', () => {
    const { provider } = makeProvider(() => ok({ sid: 'CA1' }));
    const url = 'https://switchboard.test/wh/twilio/status';
    const params = callEventToParams(
      { type: 'ringing', callSid: 'CA1', sequence: 1, at: '2026-07-15T12:00:00.000Z' },
      { accountSid: MOCK_ACCOUNT_SID, from: REP, to: LEAD, direction: 'outbound-api' },
    );
    expect(params).not.toBeNull();
    const wire = buildSignedWire(url, params ?? {}, MOCK_TWILIO_AUTH_TOKEN, 'evt-1');
    expect(provider.verifyWebhook(wire.headers, wire.rawBody, url)).toBe(true);
  });

  test('rejects a tampered body', () => {
    const { provider } = makeProvider(() => ok({ sid: 'CA1' }));
    const url = 'https://switchboard.test/wh/twilio/status';
    const params = callEventToParams(
      { type: 'ringing', callSid: 'CA1', sequence: 1, at: '2026-07-15T12:00:00.000Z' },
      { accountSid: MOCK_ACCOUNT_SID, from: REP, to: LEAD, direction: 'outbound-api' },
    );
    const wire = buildSignedWire(url, params ?? {}, MOCK_TWILIO_AUTH_TOKEN, 'evt-1');
    expect(provider.verifyWebhook(wire.headers, `${wire.rawBody}&Tampered=1`, url)).toBe(false);
  });

  test('rejects when the signature header is missing', () => {
    const { provider } = makeProvider(() => ok({ sid: 'CA1' }));
    expect(
      provider.verifyWebhook({}, 'CallSid=CA1', 'https://switchboard.test/wh/twilio/status'),
    ).toBe(false);
  });
});

describe('dropVoicemail', () => {
  test('redirects the live call to play the recording then hang up', async () => {
    const { provider, recorded } = makeProvider(() => ok({ sid: 'CA1' }));
    await provider.dropVoicemail('CA-LIVE-1', 'https://assets.test/vm.mp3');
    const req = recorded.requests[0];
    expect(req?.url).toContain('/Calls/CA-LIVE-1.json');
    expect(req?.form['Twiml']).toContain('<Play>https://assets.test/vm.mp3</Play>');
    expect(req?.form['Twiml']).toContain('<Hangup/>');
  });

  test('rejects an empty recordingRef', async () => {
    const { provider } = makeProvider(() => ok({ sid: 'CA1' }));
    await expect(provider.dropVoicemail('CA1', '')).rejects.toThrow(/recordingRef/);
  });
});

describe('FetchTwilioTransport', () => {
  test('is instantiable (production shell; not exercised over the network here)', () => {
    expect(new FetchTwilioTransport()).toBeInstanceOf(FetchTwilioTransport);
  });
});
