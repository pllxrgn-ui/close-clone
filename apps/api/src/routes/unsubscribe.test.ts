import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { enrollContacts } from '../services/sequences/enrollment.ts';
import { createUnsubscribeToken, isEmailSuppressed } from '../services/sequences/index.ts';
import {
  enrollmentState,
  makeHarness,
  seedAccount,
  seedContact,
  seedLead,
  seedSequence,
  seedTemplate,
  seedUser,
  setOrgSettings,
  type EngineHarness,
} from '../services/sequences/test-helpers.ts';
import { registerUnsubscribeRoutes } from './unsubscribe.ts';

/**
 * Public one-click unsubscribe route (CONTRACTS §C6 I-SEND-5). The token is the
 * auth; POST (RFC 8058) and GET both suppress globally and pause the contact's
 * sequences. An invalid token is a 404.
 */

const SECRET = 'unsub-test-secret';

let ctx: TestDb;
let h: EngineHarness;
let app: FastifyInstance;
let rep: string;
let lead: string;
let contact: string;
let account: string;

beforeEach(async () => {
  ctx = await createTestDb();
  h = makeHarness(ctx.db);
  rep = await seedUser(ctx.db, 'rep@switchboard.test');
  lead = await seedLead(ctx.db, 'Acme');
  contact = await seedContact(ctx.db, lead, 'dana@acme.test');
  account = await seedAccount(ctx.db, h.cipher, rep, 'rep@mock.test');
  await seedTemplate(ctx.db, rep);
  await setOrgSettings(ctx.db, {});
  app = Fastify({ logger: false });
  registerUnsubscribeRoutes(app, { db: ctx.db, secret: SECRET });
  await app.ready();
}, 120_000);

afterEach(async () => {
  await app.close();
  await ctx.close();
});

async function enroll(): Promise<string> {
  const template = await seedTemplate(ctx.db, rep);
  const { sequenceId } = await seedSequence(ctx.db, [{ type: 'email', delayHours: 0, templateId: template }]);
  const res = await enrollContacts(h.deps, {
    sequenceId,
    enrolledBy: rep,
    emailAccountId: account,
    targets: [{ leadId: lead, contactId: contact }],
  });
  return res.enrolled[0]!.enrollmentId;
}

describe('POST /unsubscribe/:token', () => {
  test('one-click suppresses globally and pauses the enrollment', async () => {
    const enrollmentId = await enroll();
    const token = createUnsubscribeToken(SECRET, 'dana@acme.test');
    const res = await app.inject({ method: 'POST', url: `/api/v1/unsubscribe/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean; unsubscribed: string }>().unsubscribed).toBe('dana@acme.test');
    expect(await isEmailSuppressed(ctx.db, 'dana@acme.test')).toBe(true);
    expect((await enrollmentState(ctx.db, enrollmentId)).state).toBe('paused');
  });

  test('GET also works (human clicking the link)', async () => {
    await enroll();
    const token = createUnsubscribeToken(SECRET, 'dana@acme.test');
    const res = await app.inject({ method: 'GET', url: `/api/v1/unsubscribe/${token}` });
    expect(res.statusCode).toBe(200);
    expect(await isEmailSuppressed(ctx.db, 'dana@acme.test')).toBe(true);
  });

  test('an invalid token is 404 (no oracle)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/unsubscribe/not-a-real-token' });
    expect(res.statusCode).toBe(404);
    expect(await isEmailSuppressed(ctx.db, 'dana@acme.test')).toBe(false);
  });
});
