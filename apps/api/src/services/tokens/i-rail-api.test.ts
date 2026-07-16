import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

import { contacts, suppressions } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { MissingReasonError, releaseSuppression } from '../audit/index.ts';
import { processIntent } from '../sequences/index.ts';
import {
  intentsForEnrollment,
  intentState,
  makeHarness,
  seedAccount,
  seedContact,
  seedLead,
  seedSequence,
  seedTemplate,
  seedUser,
  setOrgSettings,
  type EngineHarness,
} from '../sequences/test-helpers.ts';
import { registerEmailSendRoutes } from '../../routes/email-send.ts';
import { registerSequenceRoutes } from '../../routes/sequences.ts';
import { createBearerAuthPreHandler } from './pre-handler.ts';
import { PostgresRateLimiter } from './rate-limit.ts';
import { TokenService } from './service.ts';

/**
 * I-RAIL-API (CONTRACTS §C6, the one that matters): every send-safety invariant
 * MUST hold when invoked through the internal REST API. This suite gives a token
 * the FULL `write:leads` grant — it is not an auth test, the token is completely
 * authorized — and then attempts each rail bypass through the REAL routes
 * (`POST /emails/send`, `POST /sequences/:id/enroll`) plus the release engine. The
 * API has NO privileged path: the compliance rails live in the engine layer, which
 * both the route and this token must go through, so every bypass is denied.
 *
 * Bypass attempts covered (task ask): send to a suppressed address, send to DNC,
 * sequence-enroll a DNC contact (blocked at dispatch), release a suppression with
 * no reason. A clean send is the positive control proving the token is genuinely
 * authorized — the 422s are the RAILS, not the auth.
 */

const CLEAN_KEY = 'irail-clean-1';

let ctx: TestDb;
let harness: EngineHarness;
let app: FastifyInstance;
let tokenPlaintext: string;

// Seed ids.
let rep: string;
let accountId: string;
let cleanLead: string;
let cleanContact: string;
let dncLead: string;
let dncLeadContact: string;
let supLead: string;
let supContact: string;
let enrollLead: string;
let enrollDncContact: string;
let sequenceId: string;

const SUPPRESSED_EMAIL = 'suppressed@customer.test';

function auth(): { authorization: string } {
  return { authorization: `Bearer ${tokenPlaintext}` };
}

/** The mock provider bound to the sending mailbox — its send-call count is the proof. */
function sendCalls(): number {
  return harness.providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount;
}

beforeAll(async () => {
  ctx = await createTestDb();
  harness = makeHarness(ctx.db);
  await setOrgSettings(ctx.db, {}); // default cap/window (no restriction)

  rep = await seedUser(ctx.db);
  accountId = await seedAccount(ctx.db, harness.cipher, rep, 'rep@mock.test');

  cleanLead = await seedLead(ctx.db, 'Clean');
  cleanContact = await seedContact(ctx.db, cleanLead, 'clean@customer.test');

  dncLead = await seedLead(ctx.db, 'DNC', { dnc: true });
  dncLeadContact = await seedContact(ctx.db, dncLead, 'reachme@customer.test');

  supLead = await seedLead(ctx.db, 'Suppressed');
  supContact = await seedContact(ctx.db, supLead, SUPPRESSED_EMAIL);
  await ctx.db.insert(suppressions).values({
    kind: 'email',
    value: SUPPRESSED_EMAIL,
    source: 'manual',
  });

  enrollLead = await seedLead(ctx.db, 'EnrollTarget');
  enrollDncContact = await seedContact(ctx.db, enrollLead, 'enroll-dnc@customer.test', {
    dnc: true,
  });

  const tmpl = await seedTemplate(ctx.db, rep);
  ({ sequenceId } = await seedSequence(ctx.db, [
    { type: 'email', delayHours: 0, templateId: tmpl },
  ]));

  // A FULLY-authorized write token (read+write). The rails must still deny.
  const svc = new TokenService(ctx.db);
  const created = await svc.create({
    name: 'irail',
    scopes: ['read:leads', 'write:leads'],
    createdBy: rep,
  });
  tokenPlaintext = created.plaintext;

  const rateLimiter = new PostgresRateLimiter(ctx.db);
  const bearer = createBearerAuthPreHandler(
    { db: ctx.db, tokens: svc, rateLimiter },
    { scope: 'write:leads' },
  );

  app = Fastify({ logger: false });
  // Gate the WHOLE internal surface with the write-scoped bearer guard.
  app.addHook('preHandler', bearer);
  registerEmailSendRoutes(app, {
    db: ctx.db,
    providerFor: harness.providerFor,
    cipher: harness.cipher,
  });
  registerSequenceRoutes(app, {
    db: ctx.db,
    queue: harness.queue,
    now: () => harness.clock.now,
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

async function send(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/emails/send', headers: auth(), payload });
}

describe('the token is genuinely authorized (positive control)', () => {
  test('a clean send through the API succeeds and calls the provider exactly once', async () => {
    const before = sendCalls();
    const res = await send({
      actorId: rep,
      accountId,
      leadId: cleanLead,
      contactId: cleanContact,
      body: 'Hello there',
      idempotencyKey: CLEAN_KEY,
    });
    expect(res.statusCode).toBe(200);
    expect(sendCalls()).toBe(before + 1);
  });

  test('no token → 401 (the surface really is gated)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/emails/send',
      payload: { actorId: rep, accountId, leadId: cleanLead, body: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('I-RAIL-API: the rails deny every bypass, even with a valid write token', () => {
  test('send to a SUPPRESSED address → 422 SUPPRESSED, provider never called', async () => {
    const before = sendCalls();
    const res = await send({
      actorId: rep,
      accountId,
      leadId: supLead,
      contactId: supContact,
      body: 'trying anyway',
      idempotencyKey: 'irail-sup',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SUPPRESSED');
    expect(sendCalls()).toBe(before); // no send happened
  });

  test('send to a DNC lead → 422 SUPPRESSED, provider never called', async () => {
    const before = sendCalls();
    const res = await send({
      actorId: rep,
      accountId,
      leadId: dncLead,
      contactId: dncLeadContact,
      body: 'trying anyway',
      idempotencyKey: 'irail-dnc',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SUPPRESSED');
    expect(sendCalls()).toBe(before);
  });

  test('sequence-enroll a DNC contact → enrolls, but dispatch BLOCKS the send', async () => {
    const before = sendCalls();
    const enroll = await app.inject({
      method: 'POST',
      url: `/api/v1/sequences/${sequenceId}/enroll`,
      headers: auth(),
      payload: {
        enrolledBy: rep,
        emailAccountId: accountId,
        targets: [{ leadId: enrollLead, contactId: enrollDncContact }],
      },
    });
    expect(enroll.statusCode).toBe(200);
    const enrolled = enroll.json().enrolled;
    expect(enrolled).toHaveLength(1);
    const enrollmentId = enrolled[0].enrollmentId;

    // Drive the send transaction — the rail is enforced at dispatch, not enroll.
    const intents = await intentsForEnrollment(ctx.db, enrollmentId);
    const emailIntent = intents.find((i) => i.channel === 'email');
    expect(emailIntent).toBeDefined();
    const result = await processIntent(harness.deps, emailIntent!.id);

    expect(result.kind).toBe('blocked');
    const state = await intentState(ctx.db, emailIntent!.id);
    expect(state.state).toBe('BLOCKED');
    expect(state.skipReason).toBe('contact_dnc');
    expect(sendCalls()).toBe(before); // the DNC contact was never emailed
  });

  test('release a suppression with NO reason → engine refuses (no privileged API path)', async () => {
    const rows = await ctx.db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(eq(suppressions.value, SUPPRESSED_EMAIL));
    const suppressionId = rows[0]!.id;

    // The ONLY code path that clears released_at requires a non-empty reason.
    await expect(
      releaseSuppression(ctx.db, { suppressionId, reason: '   ', actorId: rep }),
    ).rejects.toBeInstanceOf(MissingReasonError);

    // The suppression is still active — so a subsequent send is still blocked.
    const res = await send({
      actorId: rep,
      accountId,
      leadId: supLead,
      contactId: supContact,
      body: 'still trying',
      idempotencyKey: 'irail-sup-2',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SUPPRESSED');
  });
});

describe('total effect', () => {
  test('across all bypass attempts, exactly one provider send occurred (the clean one)', async () => {
    // Every rail-blocked attempt short-circuited before the network.
    expect(sendCalls()).toBe(1);

    // And the still-suppressed contact was never contacted via the DNC/enroll paths.
    const stillSuppressed = await ctx.db
      .select({ value: contacts.emails })
      .from(contacts)
      .where(eq(contacts.id, enrollDncContact));
    expect(stillSuppressed).toHaveLength(1);
  });
});
