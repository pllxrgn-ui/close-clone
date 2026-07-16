import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import {
  createMockTelephonyProvider,
  type MockTelephonyProvider,
} from '../providers/telephony/index.ts';
import { addPhoneSuppression } from '../services/telephony/index.ts';
import {
  activitiesFor,
  seedContact,
  seedLead,
  seedOrgSettings,
  seedUser,
  smsFor,
} from '../services/telephony/test-helpers.ts';
import { registerSmsRoutes } from './sms.ts';

/**
 * SMS send route (CONTRACTS §C7 `POST /sms/send`, §C8, task 3f). Drives the plugin
 * through `fastify.inject` against a real PGlite DB + the 3a mock. Asserts every
 * compliance rail holds THROUGH the API (I-RAIL-API): a suppressed/DNC number is a
 * C8 SUPPRESSED (422), a send outside quiet hours is C8 OUTSIDE_WINDOW (422), and
 * the provider is never called on a block.
 */

const REP_NUMBER = '+15617770123';
const EASTERN_NUMBER = '+13055550147'; // 305 → America/New_York

const INSIDE = new Date('2026-07-15T16:00:00.000Z'); // noon Eastern
const OUTSIDE = new Date('2026-07-15T04:00:00.000Z'); // midnight Eastern

let ctx: TestDb;
let app: FastifyInstance;
let mock: MockTelephonyProvider;
let rep: string;
let lead: string;
let contact: string;

async function buildApp(now: Date): Promise<void> {
  app = Fastify({ logger: false });
  registerSmsRoutes(app, {
    db: ctx.db,
    provider: mock,
    now: () => now,
    fromNumber: REP_NUMBER,
  });
  await app.ready();
}

beforeEach(async () => {
  ctx = await createTestDb();
  mock = createMockTelephonyProvider();
  rep = await seedUser(ctx.db, { name: 'Rep' });
  lead = await seedLead(ctx.db, { name: 'Acme' });
  contact = await seedContact(ctx.db, lead, [EASTERN_NUMBER], { name: 'Dana' });
  await seedOrgSettings(ctx.db, { companyTimezone: 'UTC' });
}, 120_000);

afterEach(async () => {
  if (app !== undefined) await app.close();
  await ctx.close();
});

describe('happy path', () => {
  test('POST /api/v1/sms/send returns the send result and writes the timeline', async () => {
    await buildApp(INSIDE);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sms/send',
      payload: { userId: rep, leadId: lead, contactId: contact, body: 'Hi there' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ providerSid: string; optOutLanguageAppended: boolean }>();
    expect(body.providerSid.length).toBeGreaterThan(0);
    expect(body.optOutLanguageAppended).toBe(true);
    expect(await smsFor(ctx.db, lead)).toHaveLength(1);
    expect((await activitiesFor(ctx.db, lead)).filter((a) => a.type === 'sms_sent')).toHaveLength(1);
  });
});

describe('I-RAIL-API — rails cannot be bypassed through the API', () => {
  test('a suppressed number is C8 SUPPRESSED (422), not an override; provider not called', async () => {
    await addPhoneSuppression(ctx.db, { key: '3055550147', source: 'stop_keyword' });
    await buildApp(INSIDE);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sms/send',
      payload: { userId: rep, leadId: lead, contactId: contact, body: 'x' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SUPPRESSED');
    expect(mock.sendSmsCount).toBe(0);
    expect(await smsFor(ctx.db, lead)).toHaveLength(0);
  });

  test('a DNC lead is C8 SUPPRESSED (422)', async () => {
    const dncLead = await seedLead(ctx.db, { name: 'No', dnc: true });
    const c = await seedContact(ctx.db, dncLead, [EASTERN_NUMBER]);
    await buildApp(INSIDE);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sms/send',
      payload: { userId: rep, leadId: dncLead, contactId: c, body: 'x' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SUPPRESSED');
    expect(mock.sendSmsCount).toBe(0);
  });

  test('a send outside quiet hours is C8 OUTSIDE_WINDOW (422); provider not called', async () => {
    await buildApp(OUTSIDE);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sms/send',
      payload: { userId: rep, leadId: lead, contactId: contact, body: 'late night' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('OUTSIDE_WINDOW');
    expect(mock.sendSmsCount).toBe(0);
  });
});

describe('validation', () => {
  test('a malformed body is C8 VALIDATION_FAILED (400)', async () => {
    await buildApp(INSIDE);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sms/send',
      payload: { userId: rep, leadId: lead, body: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  test('an Idempotency-Key header dedupes a retry', async () => {
    await buildApp(INSIDE);
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/sms/send',
        headers: { 'idempotency-key': 'route-key-1' },
        payload: { userId: rep, leadId: lead, contactId: contact, body: 'once' },
      });
    const first = await send();
    const second = await send();
    expect(first.json<{ deduped: boolean }>().deduped).toBe(false);
    expect(second.json<{ deduped: boolean }>().deduped).toBe(true);
    expect(mock.deliveredSmsCount).toBe(1);
    expect(await smsFor(ctx.db, lead)).toHaveLength(1);
  });
});
