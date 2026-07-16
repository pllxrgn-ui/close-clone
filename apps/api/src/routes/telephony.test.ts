import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { webhookInbox } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import {
  MOCK_TWILIO_AUTH_TOKEN,
  buildSignedWire,
  createMockTelephonyProvider,
  readTwilioFixtureFiles,
  type MockTelephonyProvider,
  type TwilioFixtureFile,
} from '../providers/telephony/index.ts';
import {
  SignatureTwilioVerifier,
  processPendingTwilioWebhooks,
} from '../services/telephony/index.ts';
import {
  activitiesFor,
  callsFor,
  seedContact,
  seedLead,
  seedOrgSettings,
  seedUser,
} from '../services/telephony/test-helpers.ts';
import { registerTelephonyRoutes } from './telephony.ts';

/**
 * Telephony routes (CONTRACTS §C7/§C8, task 3b). Drives the plugin through
 * `fastify.inject` against a real PGlite DB + the 3a mock. Asserts: every ingress
 * is signature-verified (accept 200 / reject 403) on the recorded signed fixtures,
 * replay is a no-op, inbound routing returns owner→ring-group→voicemail TwiML, the
 * lifecycle reaches the timeline exactly once, and the dialer's I-DNC block is a C8
 * SUPPRESSED (422) THROUGH the API — never an override (I-RAIL-API).
 */

const BASE = 'https://switchboard.test';
const LEAD_NUMBER = '+13055550147';
const REP_NUMBER = '+15617770123';
const NIL = '00000000-0000-4000-8000-0000000000ff';

let ctx: TestDb;
let app: FastifyInstance;
let mock: MockTelephonyProvider;
let fixtures: TwilioFixtureFile[];
let lead: string;
let contact: string;
let rep: string;

function pathOf(url: string): string {
  return new URL(url).pathname;
}

function pick(prefix: string): TwilioFixtureFile[] {
  return fixtures.filter((f) => f.relativePath.startsWith(prefix));
}

function injectFixture(f: TwilioFixtureFile) {
  return app.inject({
    method: 'POST',
    url: pathOf(f.envelope.url),
    headers: f.envelope.headers,
    payload: f.envelope.rawBody,
  });
}

beforeEach(async () => {
  ctx = await createTestDb();
  mock = createMockTelephonyProvider();
  fixtures = readTwilioFixtureFiles();
  rep = await seedUser(ctx.db, { name: 'Owner' });
  lead = await seedLead(ctx.db, { name: 'Acme', ownerId: rep });
  contact = await seedContact(ctx.db, lead, [LEAD_NUMBER], { name: 'Dana' });
  await seedOrgSettings(ctx.db, { recordingEnabled: false });

  app = Fastify({ logger: false });
  registerTelephonyRoutes(app, {
    db: ctx.db,
    verifier: new SignatureTwilioVerifier(MOCK_TWILIO_AUTH_TOKEN),
    dialProvider: mock,
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    publicBaseUrl: BASE,
    callerId: REP_NUMBER,
  });
  await app.ready();
}, 120_000);

afterEach(async () => {
  await app.close();
  await ctx.close();
});

describe('ingress signature verification', () => {
  test('accepts every recorded fixture (200) on /status and /sms', async () => {
    for (const f of [...pick('voice-outbound-recorded/'), ...pick('sms-inbound/')]) {
      const res = await injectFixture(f);
      expect(res.statusCode).toBe(200);
    }
  });

  test('rejects a tampered body with 403 and stores nothing', async () => {
    const f = pick('voice-outbound-recorded/')[0]!;
    const res = await app.inject({
      method: 'POST',
      url: pathOf(f.envelope.url),
      headers: f.envelope.headers,
      payload: `${f.envelope.rawBody}&Injected=1`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    const rows = await ctx.db.select({ id: webhookInbox.id }).from(webhookInbox);
    expect(rows).toHaveLength(0);
  });

  test('rejects a missing signature header with 403', async () => {
    const f = pick('sms-inbound/')[0]!;
    const res = await app.inject({
      method: 'POST',
      url: pathOf(f.envelope.url),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: f.envelope.rawBody,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('replay is a no-op', () => {
  test('the same signed webhook posted twice stores one inbox row', async () => {
    const f = pick('voice-outbound-recorded/')[0]!;
    const first = await injectFixture(f);
    const second = await injectFixture(f);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const rows = await ctx.db.select({ id: webhookInbox.id }).from(webhookInbox);
    expect(rows).toHaveLength(1);
  });
});

describe('inbound voice routing → TwiML', () => {
  test('returns owner → ring-group → voicemail TwiML for a known caller', async () => {
    const rep2 = await seedUser(ctx.db, { name: 'Zrep' });
    const voice = buildSignedWire(
      `${BASE}/wh/twilio/voice`,
      {
        CallSid: 'CA-IN-1',
        From: LEAD_NUMBER,
        To: REP_NUMBER,
        Direction: 'inbound',
        CallStatus: 'ringing',
      },
      MOCK_TWILIO_AUTH_TOKEN,
      'voice-req-1',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/wh/twilio/voice',
      headers: voice.headers,
      payload: voice.rawBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain(`<Client>${rep}</Client>`); // owner first
    expect(res.body).toContain(`<Client>${rep2}</Client>`); // ring group
    expect(res.body).toContain('<Record');
  });

  test('rejects an unsigned voice request with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wh/twilio/voice',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'CallSid=CA-IN-2&From=%2B13055550147&To=%2B15617770123&Direction=inbound',
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('lifecycle → timeline (exactly once) via ingress + worker', () => {
  test('posting a recorded call stream then processing yields one call_logged', async () => {
    for (const f of pick('voice-outbound-recorded/')) {
      expect((await injectFixture(f)).statusCode).toBe(200);
    }
    await processPendingTwilioWebhooks({ db: ctx.db, provider: mock });

    const acts = await activitiesFor(ctx.db, lead);
    expect(acts.filter((a) => a.type === 'call_logged')).toHaveLength(1);
    const [call] = await callsFor(ctx.db, lead);
    expect(call?.recordingRef).toContain('/Recordings/');

    // All inbox rows consumed.
    const pending = await ctx.db
      .select({ id: webhookInbox.id })
      .from(webhookInbox)
      .where(and(eq(webhookInbox.provider, 'twilio'), isNull(webhookInbox.processedAt)));
    expect(pending).toHaveLength(0);
  });
});

describe('POST /api/v1/calls/dial', () => {
  test('dials and returns the call ids (200)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/calls/dial',
      payload: { userId: rep, leadId: lead, contactId: contact },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ callSid: string; recording: boolean }>();
    expect(body.callSid).toBeTruthy();
    expect(body.recording).toBe(false);
    expect(mock.dialCount).toBe(1);
  });

  test('I-RAIL-API: a DNC lead is 422 SUPPRESSED, never an override, provider not called', async () => {
    const dncLead = await seedLead(ctx.db, { name: 'NoContact', ownerId: rep, dnc: true });
    const dncContact = await seedContact(ctx.db, dncLead, [LEAD_NUMBER]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/calls/dial',
      payload: { userId: rep, leadId: dncLead, contactId: dncContact },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SUPPRESSED');
    expect(mock.dialCount).toBe(0);
  });

  test('a malformed dial body is 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/calls/dial',
      payload: { leadId: lead },
    });
    expect(res.statusCode).toBe(400);
  });

  test('a lead with no reachable number is 400 VALIDATION_FAILED', async () => {
    const noPhone = await seedLead(ctx.db, { name: 'NoPhone', ownerId: rep });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/calls/dial',
      payload: { userId: rep, leadId: noPhone },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('PATCH /api/v1/calls/:id', () => {
  test('updates outcome and attaches a rep note', async () => {
    const dialed = await app.inject({
      method: 'POST',
      url: '/api/v1/calls/dial',
      payload: { userId: rep, leadId: lead, contactId: contact },
    });
    const callId = dialed.json<{ callId: string }>().callId;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/calls/${callId}`,
      payload: { outcome: 'connected', notes: 'Booked a demo.', actorId: rep },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ outcome: string; noteId: string | null }>().outcome).toBe('connected');
    expect((await activitiesFor(ctx.db, lead)).filter((a) => a.type === 'note_added')).toHaveLength(
      1,
    );
  });

  test('a missing call is 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/calls/${NIL}`,
      payload: { outcome: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  test('an invalid call id is 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/calls/not-a-uuid',
      payload: { outcome: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});
