import { beforeAll, describe, expect, test } from 'vitest';
import {
  buildTwilioFixtureFiles,
  buildTwilioFixtures,
  readTwilioFixtureFiles,
  serializeFixture,
  writeTwilioFixtures,
  type TwilioFixtureFile,
} from './twilio-fixtures.ts';
import { createMockTelephonyProvider } from './mock-telephony-provider.ts';
import {
  MOCK_TWILIO_AUTH_TOKEN,
  parseFormBody,
  verifyTwilioSignature,
} from './twilio-signature.ts';
import { matchOptOutKeyword, OPT_OUT_KEYWORDS } from './opt-out.ts';

/**
 * Recorded `fixtures/twilio/**` corpus integrity (task 3a milestone 3). Proves the
 * committed fixtures are (a) byte-reproducible from the generator, (b) signed such
 * that `verifyWebhook` accepts them and rejects tampering, and (c) shaped like real
 * Twilio traffic (form-encoded params, the STOP-family opt-out bodies, a
 * voicemail-with-recording). Downstream ingress/persist-then-process tests (task
 * 3b+) replay these with the same guarantees.
 *
 * Regenerate the on-disk corpus by setting UPDATE_TWILIO_FIXTURES=1 for this run;
 * otherwise the committed files are asserted to match the freshly-built ones.
 */

// The one place the corpus path/verify token are assumed — a downstream reconciler
// (see report: fixtures/twilio vs fixtures/webhooks/twilio) touches only this.
const verifier = createMockTelephonyProvider();

function byPath(files: TwilioFixtureFile[]): Map<string, TwilioFixtureFile> {
  return new Map(files.map((f) => [f.relativePath, f]));
}

describe('twilio recorded fixtures', () => {
  let built: TwilioFixtureFile[];
  let committed: TwilioFixtureFile[];

  beforeAll(async () => {
    if (process.env.UPDATE_TWILIO_FIXTURES !== undefined) {
      await writeTwilioFixtures();
    }
    built = await buildTwilioFixtureFiles();
    committed = readTwilioFixtureFiles();
  });

  describe('generation is deterministic and matches the committed corpus', () => {
    test('two builds are byte-identical (serialized)', async () => {
      const a = (await buildTwilioFixtureFiles()).map((f) => serializeFixture(f.envelope));
      const b = (await buildTwilioFixtureFiles()).map((f) => serializeFixture(f.envelope));
      expect(a).toEqual(b);
    });

    test('committed files exist and deep-equal the freshly-built envelopes (drift lock)', () => {
      expect(committed.length).toBeGreaterThan(0);
      expect(committed.length).toBe(built.length);
      const builtByPath = byPath(built);
      for (const file of committed) {
        const match = builtByPath.get(file.relativePath);
        expect(match, `no generator output for committed ${file.relativePath}`).toBeDefined();
        expect(file.envelope).toEqual(match?.envelope);
      }
    });

    test('every committed file is on-disk serialized exactly as the generator writes it', () => {
      // Parsed deep-equality above tolerates whitespace; this pins the byte form too.
      const builtByPath = byPath(built);
      for (const file of committed) {
        const expected = serializeFixture(builtByPath.get(file.relativePath)!.envelope);
        expect(serializeFixture(file.envelope)).toBe(expected);
      }
    });
  });

  describe('envelope shape (real Twilio wire semantics)', () => {
    test('each fixture is a signed, form-encoded twilio envelope with a signable url', () => {
      for (const { relativePath, envelope } of committed) {
        expect(envelope.provider, relativePath).toBe('twilio');
        expect(['voice', 'sms']).toContain(envelope.channel);
        expect(envelope.url, relativePath).toMatch(/^https:\/\/switchboard\.test\/wh\/twilio\//);
        expect(envelope.headers['Content-Type'], relativePath).toBe(
          'application/x-www-form-urlencoded',
        );
        expect(envelope.headers['X-Twilio-Signature'], relativePath).toBeDefined();
        expect(envelope.payload.AccountSid, relativePath).toMatch(/^AC/);
        // rawBody form-decodes back to the parsed payload view.
        expect(parseFormBody(envelope.rawBody)).toEqual(envelope.payload);
      }
    });

    test('eventIds are unique across the whole corpus (webhook_inbox dedupe key)', () => {
      const ids = committed.map((f) => f.envelope.eventId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('signature verification (ingress accept + reject)', () => {
    test('verifyWebhook accepts every recorded fixture', () => {
      for (const { relativePath, envelope } of committed) {
        expect(
          verifier.verifyWebhook(envelope.headers, envelope.rawBody, envelope.url),
          relativePath,
        ).toBe(true);
        // standalone signer agrees
        expect(
          verifyTwilioSignature(
            envelope.url,
            envelope.rawBody,
            envelope.headers['X-Twilio-Signature'],
            MOCK_TWILIO_AUTH_TOKEN,
          ),
          relativePath,
        ).toBe(true);
      }
    });

    test('a tampered body, url, or signature is rejected', () => {
      const sample = committed[0];
      expect(sample).toBeDefined();
      if (sample === undefined) return;
      const { headers, rawBody, url } = sample.envelope;
      expect(verifier.verifyWebhook(headers, `${rawBody}&Injected=1`, url)).toBe(false);
      expect(verifier.verifyWebhook(headers, rawBody, `${url}?evil=1`)).toBe(false);
      expect(verifier.verifyWebhook({ 'X-Twilio-Signature': 'AAAA' }, rawBody, url)).toBe(false);
    });

    test('the wrong auth token rejects a valid fixture', () => {
      const { envelope } = committed[0]!;
      expect(
        verifyTwilioSignature(
          envelope.url,
          envelope.rawBody,
          envelope.headers['X-Twilio-Signature'],
          'not-the-mock-token',
        ),
      ).toBe(false);
    });
  });

  describe('voice-outbound-recorded (consent-gated recording on the wire, §I-REC)', () => {
    const callStatusesIn = (dir: string): (string | undefined)[] =>
      committed
        .filter((f) => f.relativePath.startsWith(`${dir}/`))
        .map((f) => f.envelope.payload.CallStatus);

    test('posts status + recording callbacks and NO consent-marker webhook', () => {
      const files = committed.filter((f) => f.relativePath.startsWith('voice-outbound-recorded/'));
      const statuses = files.map((f) => f.envelope.payload.CallStatus).filter(Boolean);
      expect(statuses).toEqual(['queued', 'ringing', 'in-progress', 'completed']);
      // recording status callbacks present
      const recStatuses = files
        .map((f) => f.envelope.payload.RecordingStatus)
        .filter((s): s is string => s !== undefined);
      expect(recStatuses).toEqual(['in-progress', 'completed']);
      // Exactly the six wire events — the 7th lifecycle marker (consent) has no
      // webhook, so it never reaches recorded traffic.
      expect(files).toHaveLength(6);
      const completed = files.find((f) => f.envelope.payload.RecordingStatus === 'completed');
      expect(completed?.envelope.payload.RecordingUrl).toContain('/Recordings/');
      expect(Number(completed?.envelope.payload.RecordingDuration)).toBeGreaterThan(0);
    });

    test('the unrecorded outbound call has zero recording callbacks (negative §I-REC)', () => {
      const files = committed.filter((f) =>
        f.relativePath.startsWith('voice-outbound-unrecorded/'),
      );
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((f) => f.envelope.payload.RecordingStatus === undefined)).toBe(true);
      expect(files.every((f) => f.envelope.payload.RecordingUrl === undefined)).toBe(true);
      expect(callStatusesIn('voice-outbound-unrecorded')).toEqual([
        'queued',
        'ringing',
        'in-progress',
        'completed',
      ]);
    });
  });

  describe('voice-inbound-voicemail (3c/3d consume the recording ref)', () => {
    test('carries a RecordingUrl + positive RecordingDuration', () => {
      const vm = committed.find(
        (f) =>
          f.relativePath.startsWith('voice-inbound-voicemail/') && f.envelope.payload.RecordingUrl,
      );
      expect(vm).toBeDefined();
      expect(vm?.envelope.payload.RecordingUrl).toContain('/Recordings/');
      expect(Number(vm?.envelope.payload.RecordingDuration)).toBeGreaterThan(0);
      expect(vm?.envelope.payload.AnsweredBy).toMatch(/machine/);
    });
  });

  describe('sms-inbound (STOP-family opt-out shapes parse, §I-QUIET)', () => {
    test('one fixture per opt-out keyword, each classifying as an opt-out', () => {
      const smsFiles = committed.filter((f) => f.relativePath.startsWith('sms-inbound/'));
      const optOutBodies = smsFiles
        .map((f) => f.envelope.payload.Body)
        .filter((b): b is string => b !== undefined && matchOptOutKeyword(b) !== null);
      expect(optOutBodies.sort()).toEqual([...OPT_OUT_KEYWORDS].sort());

      for (const keyword of OPT_OUT_KEYWORDS) {
        const file = smsFiles.find((f) => f.envelope.payload.Body === keyword);
        expect(file, `missing fixture for ${keyword}`).toBeDefined();
        if (file === undefined) continue;
        expect(file.envelope.channel).toBe('sms');
        expect(file.envelope.url).toBe('https://switchboard.test/wh/twilio/sms');
        expect(file.envelope.payload.MessageSid).toMatch(/^SM/);
        expect(file.envelope.payload.From).toBe('+13055550147');
        expect(matchOptOutKeyword(file.envelope.payload.Body ?? '')).toBe(keyword);
      }
    });

    test('the ordinary reply is present and is NOT an opt-out', () => {
      const reply = committed.find((f) => f.relativePath.endsWith('-reply.json'));
      expect(reply).toBeDefined();
      expect(matchOptOutKeyword(reply?.envelope.payload.Body ?? '')).toBeNull();
    });
  });

  describe('corpus README lists every stream', () => {
    test('build streams carry a description (surfaced in the corpus README)', async () => {
      const streams = await buildTwilioFixtures();
      expect(streams.length).toBeGreaterThanOrEqual(4);
      for (const s of streams) {
        expect(s.description.length).toBeGreaterThan(0);
        expect(s.files.length).toBeGreaterThan(0);
      }
    });
  });
});
