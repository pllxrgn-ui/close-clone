import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { orgSettings, type Db } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import {
  createMockTelephonyProvider,
  type MockTelephonyProvider,
} from '../../providers/telephony/index.ts';
import type { CallLifecycleEvent } from '@switchboard/shared/providers';
import { dialCall, type DialDeps } from './dial.ts';
import {
  parseTwilioWebhook,
  persistTwilioWebhook,
  processPendingTwilioWebhooks,
  type TelephonyProcessDeps,
  type TwilioChannel,
} from './index.ts';
import { callHasRecordingConsent } from './recording.ts';
import { activitiesFor, callsFor, seedContact, seedLead, seedOrgSettings, seedUser } from './test-helpers.ts';

/**
 * §I-REC property suite (task 3d acceptance): across every combination of the org
 * recording flag and the per-call rep opt-out, recording NEVER starts without BOTH
 * the org flag AND a `recording_consent_played` marker preceding it — proven at two
 * levels driven end-to-end (dial → mock lifecycle → ingress → process):
 *
 *   (a) provider lifecycle: `recording_started`/`recording_completed` appear only
 *       when armed, and always AFTER a `recording_consent_played` event;
 *   (b) persisted DB state: `calls.recording_ref` is non-null IFF armed, and a
 *       non-null ref always co-exists with a consent activity that is no later than
 *       the logged call.
 */

const LEAD_NUMBER = '+13055550147';
const REP_NUMBER = '+15617770123';

let ctx: TestDb;
let db: Db;
let mock: MockTelephonyProvider;
let dialDeps: DialDeps;
let processDeps: TelephonyProcessDeps;
let rep: string;

function channelForUrl(url: string): TwilioChannel {
  if (url.endsWith('/sms')) return 'sms';
  if (url.endsWith('/voice')) return 'voice';
  return 'status';
}

/** Release every due webhook and run them through the real ingress + processor. */
async function drainLifecycle(): Promise<void> {
  const delivered = mock.pump();
  for (const w of delivered) {
    if (w.wire === undefined) continue;
    const parsed = parseTwilioWebhook(channelForUrl(w.wire.url), w.wire.rawBody);
    await persistTwilioWebhook(db, parsed, w.receivedAt);
  }
  await processPendingTwilioWebhooks(processDeps);
}

function recordingEvents(events: CallLifecycleEvent[]): CallLifecycleEvent[] {
  return events.filter(
    (e) => e.type === 'recording_started' || e.type === 'recording_completed',
  );
}

async function setOrgRecording(enabled: boolean): Promise<void> {
  await db.update(orgSettings).set({ recordingEnabled: enabled });
}

beforeEach(async () => {
  ctx = await createTestDb();
  db = ctx.db;
  mock = createMockTelephonyProvider();
  dialDeps = { db, provider: mock, now: () => new Date('2026-07-15T12:00:00.000Z'), callerId: REP_NUMBER };
  processDeps = { db, provider: mock };
  rep = await seedUser(db, { name: 'Rep' });
  await seedOrgSettings(db, { recordingEnabled: false });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

interface Case {
  recordingEnabled: boolean;
  recordOptOut: boolean | undefined;
}

// Exhaustive over the meaningful inputs; `armed` is the ONLY combination that may record.
const CASES: Case[] = [
  { recordingEnabled: false, recordOptOut: undefined },
  { recordingEnabled: false, recordOptOut: false },
  { recordingEnabled: false, recordOptOut: true },
  { recordingEnabled: true, recordOptOut: undefined },
  { recordingEnabled: true, recordOptOut: false },
  { recordingEnabled: true, recordOptOut: true },
];

async function runCase(c: Case, label: string): Promise<void> {
  const armed = c.recordingEnabled && c.recordOptOut !== true;
  await setOrgRecording(c.recordingEnabled);
  const lead = await seedLead(db, { name: `Lead ${label}` });
  const contact = await seedContact(db, lead, [LEAD_NUMBER], { name: 'Dana' });

  const out = await dialCall(dialDeps, {
    userId: rep,
    leadId: lead,
    contactId: contact,
    ...(c.recordOptOut !== undefined ? { recordOptOut: c.recordOptOut } : {}),
  });
  expect(out.recording).toBe(armed);

  // (a) Provider-lifecycle invariant.
  const lifecycle = mock.lifecycleFor(out.callSid);
  const recs = recordingEvents(lifecycle);
  const consentIdx = lifecycle.findIndex((e) => e.type === 'recording_consent_played');
  if (armed) {
    expect(recs.length).toBeGreaterThan(0);
    expect(consentIdx).toBeGreaterThanOrEqual(0);
    // Every recording event is strictly after the consent marker.
    for (const r of recs) {
      const rIdx = lifecycle.indexOf(r);
      expect(rIdx).toBeGreaterThan(consentIdx);
      expect(r.sequence).toBeGreaterThan(lifecycle[consentIdx]!.sequence);
    }
  } else {
    expect(recs).toHaveLength(0);
    expect(consentIdx).toBe(-1);
  }

  // Drive the whole stream through ingress + processor.
  await drainLifecycle();

  // (b) Persisted-state invariant.
  const callRows = await callsFor(db, lead);
  const call = callRows[0];
  expect(call).toBeDefined();
  const hasConsent = await callHasRecordingConsent(db, lead, call!.id);

  // THE property: a recording ref never exists without a preceding consent event.
  if (call!.recordingRef !== null) expect(hasConsent).toBe(true);

  if (armed) {
    expect(call!.recordingRef).not.toBeNull();
    expect(hasConsent).toBe(true);
    const acts = await activitiesFor(db, lead);
    const consent = acts.find((a) => a.type === 'recording_consent_played');
    const logged = acts.find((a) => a.type === 'call_logged');
    expect(consent).toBeDefined();
    expect(logged).toBeDefined();
    expect(consent!.occurredAt <= logged!.occurredAt).toBe(true);
  } else {
    expect(call!.recordingRef).toBeNull();
    expect(hasConsent).toBe(false);
  }
}

describe('I-REC — recording requires org flag AND preceding consent', () => {
  for (const c of CASES) {
    const armed = c.recordingEnabled && c.recordOptOut !== true;
    test(`enabled=${c.recordingEnabled} optOut=${String(c.recordOptOut)} → ${armed ? 'records (consent first)' : 'never records'}`, async () => {
      await runCase(c, `${c.recordingEnabled}-${String(c.recordOptOut)}`);
    });
  }

  test('randomized interleaving of cases holds the invariant every time', async () => {
    // Deterministic LCG over the case matrix — a compact stand-in for fast-check.
    let state = 20260715;
    for (let i = 0; i < 40; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const c = CASES[state % CASES.length]!;
      await runCase(c, `rand-${i}`);
    }
  });
});
