import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManualClock, SequentialIds } from '../mock/clock.ts';
import {
  createMockTelephonyProvider,
  type EmittedTelephonyWebhook,
} from './mock-telephony-provider.ts';
import {
  inboundVoicemailSteps,
  toFixtureEnvelope,
  type TwilioFixtureEnvelope,
} from './twilio-wire.ts';
import { OPT_OUT_KEYWORDS } from './opt-out.ts';

/**
 * Recorded-style Twilio webhook fixtures (task 3a milestone 3). These are the
 * `fixtures/twilio/**` corpus the ingress/persist-then-process tests (ARCHITECTURE
 * §5) and the real Twilio adapter tests (task 3b) replay **without any external
 * account** — the exact form-encoded, `X-Twilio-Signature`-signed payloads Twilio
 * POSTs to `/wh/twilio/status` and `/wh/twilio/sms`.
 *
 * They are generated, not hand-written, by driving a single deterministic
 * `MockTelephonyProvider` session (one shared `ManualClock` + `SequentialIds`) and
 * capturing its emitted wire payloads. Because the mock signs with
 * `MOCK_TWILIO_AUTH_TOKEN`, `verifyWebhook(headers, rawBody, url)` accepts every
 * fixture — so a recorded fixture and a live mock emission are byte-identical, and
 * the whole corpus is internally consistent (globally-unique SIDs, monotonic time).
 *
 * The consent-announcement marker (`recording_consent_played`) is intentionally
 * ABSENT from the corpus: Twilio has no webhook for it (it is an adapter-internal
 * lifecycle marker), so it never appears as recorded traffic — §I-REC lives at the
 * adapter line, not on the wire.
 *
 * Regenerate with `UPDATE_TWILIO_FIXTURES=1 pnpm --filter @switchboard/api test`
 * (see `twilio-fixtures.test.ts`); the committed files are otherwise a drift lock.
 */

/** One recorded fixture: a path relative to the twilio fixtures dir + its envelope. */
export interface TwilioFixtureFile {
  /** POSIX-style path relative to `fixtures/twilio/` (forward slashes). */
  relativePath: string;
  envelope: TwilioFixtureEnvelope;
}

/** A named, ordered group of recorded fixtures (a single replayable stream). */
export interface TwilioFixtureStream {
  /** Sub-directory under `fixtures/twilio/`. */
  dir: string;
  /** Human note written into the corpus README. */
  description: string;
  files: TwilioFixtureFile[];
}

// Deterministic session inputs — pinned so the corpus is byte-reproducible.
const FIXTURE_CLOCK_START = '2026-07-15T12:00:00.000Z';
const INTER_STREAM_GAP_MS = 60_000;

// Fixed E.164 endpoints (rep line vs. lead line); inbound swaps direction.
const REP_NUMBER = '+15617770123';
const LEAD_NUMBER = '+13055550147';

/** 4-digit zero-padded sequence prefix (§ fixtures/webhooks README ordering rule). */
function seqPrefix(n: number): string {
  return String(n).padStart(4, '0');
}

/** Kebab-case an event type for a filename slug (`recording_started` → `recording-started`). */
function slug(type: string): string {
  return type.replace(/_/g, '-');
}

/** Narrow a delivered webhook to those Twilio actually POSTs (a signed wire body). */
function withWire(
  webhooks: EmittedTelephonyWebhook[],
): (EmittedTelephonyWebhook & { wire: NonNullable<EmittedTelephonyWebhook['wire']> })[] {
  return webhooks.flatMap((w) => (w.wire !== undefined ? [{ ...w, wire: w.wire }] : []));
}

/**
 * Build the full recorded-fixture corpus in memory. Pure and deterministic: the
 * same inputs always yield the same envelopes (including signatures), so callers
 * can diff the result against the committed files.
 */
export async function buildTwilioFixtures(): Promise<TwilioFixtureStream[]> {
  const clock = new ManualClock(FIXTURE_CLOCK_START);
  const provider = createMockTelephonyProvider({ clock, ids: new SequentialIds() });

  // --- Stream 1: outbound call, recorded (consent-gated, §I-REC on the wire) ---
  // A full recorded call: queued → ringing → answered → recording start/complete →
  // completed. The consent marker precedes recording at the adapter line but has no
  // webhook, so it is not among these recorded events.
  await provider.dial(REP_NUMBER, LEAD_NUMBER, { record: true, consentAnnouncement: true });
  const recordedVoice = withWire(provider.pump());

  clock.advance(INTER_STREAM_GAP_MS);

  // --- Stream 2: outbound call, NOT recorded (record=false) ---
  // Proves the negative I-REC path on the wire: no recording callbacks at all.
  await provider.dial(REP_NUMBER, LEAD_NUMBER, { record: false, consentAnnouncement: false });
  const unrecordedVoice = withWire(provider.pump());

  clock.advance(INTER_STREAM_GAP_MS);

  // --- Stream 3: inbound call → voicemail with a recording ref + duration ---
  provider.injectInboundCall({ from: LEAD_NUMBER, to: REP_NUMBER, steps: inboundVoicemailSteps() });
  const inboundVoicemail = withWire(provider.pump());

  clock.advance(INTER_STREAM_GAP_MS);

  // --- Stream 4: inbound SMS — every STOP-family keyword + one ordinary reply ---
  const smsFiles: TwilioFixtureFile[] = [];
  let smsIndex = 1;
  for (const keyword of OPT_OUT_KEYWORDS) {
    provider.injectInboundSms({ from: LEAD_NUMBER, to: REP_NUMBER, body: keyword });
    const [sms] = withWire(provider.pump());
    if (sms === undefined)
      throw new Error(`fixture gen: STOP-family SMS ${keyword} produced no wire`);
    smsFiles.push({
      relativePath: `sms-inbound/${seqPrefix(smsIndex)}-${keyword.toLowerCase()}.json`,
      envelope: toFixtureEnvelope('sms', sms.wire, sms.receivedAt),
    });
    smsIndex += 1;
  }
  provider.injectInboundSms({
    from: LEAD_NUMBER,
    to: REP_NUMBER,
    body: 'Sounds great, call me tomorrow.',
  });
  const [reply] = withWire(provider.pump());
  if (reply === undefined) throw new Error('fixture gen: ordinary SMS produced no wire');
  smsFiles.push({
    relativePath: `sms-inbound/${seqPrefix(smsIndex)}-reply.json`,
    envelope: toFixtureEnvelope('sms', reply.wire, reply.receivedAt),
  });

  const voiceFiles = (
    stream: (EmittedTelephonyWebhook & { wire: NonNullable<EmittedTelephonyWebhook['wire']> })[],
    dir: string,
  ): TwilioFixtureFile[] =>
    stream.map((w, i) => {
      const type = 'type' in w.event ? w.event.type : 'sms';
      return {
        relativePath: `${dir}/${seqPrefix(i + 1)}-${slug(type)}.json`,
        envelope: toFixtureEnvelope('voice', w.wire, w.receivedAt),
      };
    });

  return [
    {
      dir: 'voice-outbound-recorded',
      description:
        'Outbound call with recording armed (record + consent). Status + recording-status callbacks; the consent marker has no webhook.',
      files: voiceFiles(recordedVoice, 'voice-outbound-recorded'),
    },
    {
      dir: 'voice-outbound-unrecorded',
      description:
        'Outbound call with recording OFF (record=false). No recording callbacks appear on the wire (negative §I-REC).',
      files: voiceFiles(unrecordedVoice, 'voice-outbound-unrecorded'),
    },
    {
      dir: 'voice-inbound-voicemail',
      description:
        'Inbound call that rang unanswered and left a voicemail — carries a RecordingUrl + RecordingDuration (3c/3d consume the ref).',
      files: voiceFiles(inboundVoicemail, 'voice-inbound-voicemail'),
    },
    {
      dir: 'sms-inbound',
      description:
        'Independent inbound SMS deliveries: one per STOP/UNSUBSCRIBE/QUIT/CANCEL/END opt-out keyword (§I-QUIET) plus one ordinary reply.',
      files: smsFiles,
    },
  ];
}

/** Flatten the corpus to a path→envelope list (write/compare convenience). */
export async function buildTwilioFixtureFiles(): Promise<TwilioFixtureFile[]> {
  const streams = await buildTwilioFixtures();
  return streams.flatMap((s) => s.files);
}

/** Absolute path to the committed `fixtures/webhooks/twilio/` corpus (resolved from repo root). */
export function twilioFixturesDir(): string {
  // this file: <root>/apps/api/src/providers/telephony/twilio-fixtures.ts
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../../../fixtures/webhooks/twilio');
}

/** Serialize an envelope the way the corpus is stored (matches Prettier's JSON). */
export function serializeFixture(envelope: TwilioFixtureEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** Read the committed corpus back as path→envelope entries (filename-sorted per dir). */
export function readTwilioFixtureFiles(dir: string = twilioFixturesDir()): TwilioFixtureFile[] {
  const files: TwilioFixtureFile[] = [];
  for (const sub of readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subDir = join(dir, sub.name);
    for (const name of readdirSync(subDir)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      const raw = readFileSync(join(subDir, name), 'utf8');
      files.push({
        relativePath: `${sub.name}/${name}`,
        envelope: JSON.parse(raw) as TwilioFixtureEnvelope,
      });
    }
  }
  return files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
}

/**
 * (Re)generate the corpus on disk: wipe the per-stream sub-directories and write the
 * freshly-built envelopes. Cross-platform (Node `fs`/`path`, no shell). Invoked by
 * the env-gated regen path in the test, or directly under Node ≥24 via the
 * main-guard below.
 */
export async function writeTwilioFixtures(dir: string = twilioFixturesDir()): Promise<string[]> {
  const streams = await buildTwilioFixtures();
  mkdirSync(dir, { recursive: true });
  for (const stream of streams) {
    const subDir = join(dir, stream.dir);
    if (existsSync(subDir)) rmSync(subDir, { recursive: true, force: true });
    mkdirSync(subDir, { recursive: true });
    for (const file of stream.files) {
      writeFileSync(join(dir, file.relativePath), serializeFixture(file.envelope), 'utf8');
    }
  }
  return streams.flatMap((s) => s.files.map((f) => f.relativePath));
}

// Node ≥24 convenience (`node twilio-fixtures.ts`); the portable path is the
// env-gated vitest regen. `import.meta.url` equals the invoked path only when run
// directly, so importing this module never writes files.
if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) {
  writeTwilioFixtures()
    .then((written) => {
      process.stdout.write(`wrote ${written.length} twilio fixtures\n`);
    })
    .catch((err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exitCode = 1;
    });
}
