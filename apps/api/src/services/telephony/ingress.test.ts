import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { webhookInbox } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import {
  MOCK_TWILIO_AUTH_TOKEN,
  readTwilioFixtureFiles,
  type TwilioFixtureFile,
} from '../../providers/telephony/index.ts';
import {
  InvalidTwilioWebhookError,
  SignatureTwilioVerifier,
  parseTwilioWebhook,
  persistTwilioWebhook,
  type TwilioChannel,
} from './ingress.ts';

/**
 * Twilio ingress (task 3b): the parse/verify/persist layer. Verification runs
 * against the recorded 3a fixtures (signed with the mock auth token) so BOTH the
 * accept and reject paths are exercised on real signed bytes; persistence is
 * dedupe-safe on the derived per-event id.
 */

let ctx: TestDb;
let fixtures: TwilioFixtureFile[];
const verifier = new SignatureTwilioVerifier(MOCK_TWILIO_AUTH_TOKEN);

function channelForUrl(url: string): TwilioChannel {
  if (url.endsWith('/sms')) return 'sms';
  if (url.endsWith('/voice')) return 'voice';
  return 'status';
}

beforeEach(async () => {
  ctx = await createTestDb();
  fixtures = readTwilioFixtureFiles();
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('signature verification (every ingress)', () => {
  test('accepts every recorded fixture signed with the mock auth token', () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      expect(verifier.verify(f.envelope.headers, f.envelope.rawBody, f.envelope.url)).toBe(true);
    }
  });

  test('rejects a tampered body', () => {
    const f = fixtures[0]!;
    expect(
      verifier.verify(f.envelope.headers, `${f.envelope.rawBody}&Injected=1`, f.envelope.url),
    ).toBe(false);
  });

  test('rejects a mismatched URL', () => {
    const f = fixtures[0]!;
    expect(
      verifier.verify(f.envelope.headers, f.envelope.rawBody, 'https://evil.test/wh/twilio/status'),
    ).toBe(false);
  });

  test('rejects the wrong auth token', () => {
    const wrong = new SignatureTwilioVerifier('not-the-token');
    const f = fixtures[0]!;
    expect(wrong.verify(f.envelope.headers, f.envelope.rawBody, f.envelope.url)).toBe(false);
  });

  test('rejects a missing signature header', () => {
    const f = fixtures[0]!;
    expect(verifier.verify({}, f.envelope.rawBody, f.envelope.url)).toBe(false);
  });
});

describe('provider_event_id derivation', () => {
  test('sms → MessageSid', () => {
    const body = 'MessageSid=SM123&From=%2B13055550147&To=%2B15617770123&Body=STOP';
    expect(parseTwilioWebhook('sms', body).eventId).toBe('SM123');
  });

  test('voice → <CallSid>:voice', () => {
    const body = 'CallSid=CA1&From=%2B1&To=%2B2&CallStatus=ringing';
    expect(parseTwilioWebhook('voice', body).eventId).toBe('CA1:voice');
  });

  test('status call callback → <CallSid>:call:<CallStatus>:<Seq>', () => {
    const body = 'CallSid=CA1&CallStatus=completed&SequenceNumber=6&CallDuration=42';
    expect(parseTwilioWebhook('status', body).eventId).toBe('CA1:call:completed:6');
  });

  test('status recording callback → <CallSid>:rec:<RecordingSid>:<RecordingStatus>', () => {
    const body =
      'CallSid=CA1&RecordingSid=RE9&RecordingStatus=completed&RecordingUrl=http%3A%2F%2Fx';
    expect(parseTwilioWebhook('status', body).eventId).toBe('CA1:rec:RE9:completed');
  });

  test('distinct lifecycle callbacks never collide; a replay yields the same key', () => {
    const recorded = fixtures.filter((f) => f.relativePath.startsWith('voice-outbound-recorded/'));
    const ids = recorded.map(
      (f) => parseTwilioWebhook(channelForUrl(f.envelope.url), f.envelope.rawBody).eventId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a malformed body (no CallSid/MessageSid) is rejected', () => {
    expect(() => parseTwilioWebhook('status', 'Foo=bar')).toThrow(InvalidTwilioWebhookError);
    expect(() => parseTwilioWebhook('sms', 'Foo=bar')).toThrow(InvalidTwilioWebhookError);
  });
});

describe('persist is dedupe-safe (replay = no-op)', () => {
  test('the same event persists once; the replay conflicts and no-ops', async () => {
    const f = fixtures.find((x) => x.relativePath.startsWith('voice-outbound-recorded/'))!;
    const parsed = parseTwilioWebhook(channelForUrl(f.envelope.url), f.envelope.rawBody);

    const first = await persistTwilioWebhook(ctx.db, parsed, f.envelope.receivedAt);
    const second = await persistTwilioWebhook(ctx.db, parsed, f.envelope.receivedAt);
    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);

    const rows = await ctx.db
      .select({ id: webhookInbox.id })
      .from(webhookInbox)
      .where(eq(webhookInbox.providerEventId, parsed.eventId));
    expect(rows).toHaveLength(1);
  });
});
