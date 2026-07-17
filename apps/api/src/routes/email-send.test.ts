import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { emailAccounts, emailMessages, leads, suppressions, type Db } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { MockEmailProvider } from '../providers/mock/mock-email-provider.ts';
import { TokenCipher } from '../services/sync/token-cipher.ts';
import { activitiesFor, seedContact, seedLead, seedUser } from '../services/email/test-helpers.ts';
import { registerEmailSendRoutes } from './email-send.ts';

/**
 * POST /api/v1/emails/send (CONTRACTS §C7/§C8, task 2d). Drives the route through
 * `fastify.inject` against a real PGlite DB + per-account MockEmailProvider. The
 * key assertion is I-RAIL-API: a send to a suppressed / DNC recipient is refused
 * with C8 SUPPRESSED (422) THROUGH the API — the rails cannot be bypassed — never
 * an override prompt. Also: happy 200, merge failure 400, idempotent double-POST.
 */

const SECRET = 'route-send-secret';

let ctx: TestDb;
let app: FastifyInstance;
let cipher: TokenCipher;
let providers: Map<string, MockEmailProvider>;
let rep: string;
let lead: string;
let accountId: string;

function providerFor(identity: { address: string; provider: 'gmail' | 'mock' }): MockEmailProvider {
  const key = identity.address.toLowerCase();
  let p = providers.get(key);
  if (p === undefined) {
    p = new MockEmailProvider({ address: identity.address });
    providers.set(key, p);
  }
  return p;
}

async function seedAccount(db: Db, userId: string, address: string): Promise<string> {
  const enc = cipher.encrypt({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    tokenType: 'Bearer',
  });
  const rows = await db
    .insert(emailAccounts)
    .values({ userId, address, provider: 'mock', syncStatus: 'LIVE', oauthTokens: enc })
    .returning({ id: emailAccounts.id });
  return rows[0]!.id;
}

beforeEach(async () => {
  ctx = await createTestDb();
  cipher = new TokenCipher(SECRET);
  providers = new Map();
  rep = await seedUser(ctx.db, { email: 'rep@example.com' });
  lead = await seedLead(ctx.db, 'Acme');
  await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
  accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');

  app = Fastify({ logger: false });
  registerEmailSendRoutes(app, { db: ctx.db, providerFor, cipher });
  await app.ready();
}, 120_000);

afterEach(async () => {
  await app.close();
  await ctx.close();
});

function post(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/api/v1/emails/send', payload, headers });
}

describe('happy path', () => {
  test('sends and returns the persisted ids', async () => {
    const res = await post({
      actorId: rep,
      accountId,
      leadId: lead,
      to: ['dana@acme.test'],
      subject: 'Hi {{lead.name}}',
      body: 'Hello',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ messageId: string; deduped: boolean; providerMessageId: string }>();
    expect(body.deduped).toBe(false);
    expect(body.messageId).toBeTruthy();
    expect((await activitiesFor(ctx.db, lead)).filter((a) => a.type === 'email_sent')).toHaveLength(
      1,
    );
  });
});

describe('I-RAIL-API — rails cannot be bypassed via the API', () => {
  test('a suppressed recipient is 422 SUPPRESSED, never a prompt, nothing sent', async () => {
    await ctx.db
      .insert(suppressions)
      .values({ kind: 'email', value: 'dana@acme.test', source: 'unsubscribe' });
    const res = await post({
      actorId: rep,
      accountId,
      leadId: lead,
      to: ['dana@acme.test'],
      body: 'Hi',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SUPPRESSED');
    expect(providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount).toBe(0);
    expect(
      await ctx.db.select().from(emailMessages).where(eq(emailMessages.accountId, accountId)),
    ).toHaveLength(0);
  });

  test('a DNC lead is 422 SUPPRESSED', async () => {
    const dncLead = await seedLead(ctx.db, 'NoContact');
    await ctx.db.update(leads).set({ dnc: true }).where(eq(leads.id, dncLead));
    const res = await post({
      actorId: rep,
      accountId,
      leadId: dncLead,
      to: ['x@y.test'],
      body: 'Hi',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SUPPRESSED');
  });
});

describe('validation', () => {
  test('an unresolved merge tag is 400 VALIDATION_FAILED', async () => {
    // seedContact leaves `title` null → {{contact.title}} cannot resolve.
    const cid = await seedContact(ctx.db, lead, ['nt@acme.test'], { name: 'NoTitle' });
    const res = await post({
      actorId: rep,
      accountId,
      leadId: lead,
      contactId: cid,
      body: 'Hi {{contact.title}}',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  test('a malformed body is 400', async () => {
    const res = await post({ accountId, leadId: lead, to: ['x@y.test'], body: 'Hi' });
    expect(res.statusCode).toBe(400);
  });

  test('a missing account is 404', async () => {
    const NIL = '00000000-0000-4000-8000-0000000000ff';
    const res = await post({
      actorId: rep,
      accountId: NIL,
      leadId: lead,
      to: ['x@y.test'],
      body: 'Hi',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});

describe('idempotent double-POST', () => {
  test('the same idempotency key sends once and writes one activity', async () => {
    const payload = {
      actorId: rep,
      accountId,
      leadId: lead,
      to: ['dana@acme.test'],
      body: 'Hi',
      idempotencyKey: 'post-key-1',
    };
    const first = await post(payload);
    const second = await post(payload);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ deduped: boolean }>().deduped).toBe(false);
    expect(second.json<{ deduped: boolean }>().deduped).toBe(true);

    expect(providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount).toBe(1);
    expect(
      await ctx.db.select().from(emailMessages).where(eq(emailMessages.accountId, accountId)),
    ).toHaveLength(1);
    expect((await activitiesFor(ctx.db, lead)).filter((a) => a.type === 'email_sent')).toHaveLength(
      1,
    );
  });

  test('honours an Idempotency-Key header when the body omits one', async () => {
    const payload = { actorId: rep, accountId, leadId: lead, to: ['dana@acme.test'], body: 'Hi' };
    const first = await post(payload, { 'idempotency-key': 'hdr-1' });
    const second = await post(payload, { 'idempotency-key': 'hdr-1' });
    expect(first.json<{ deduped: boolean }>().deduped).toBe(false);
    expect(second.json<{ deduped: boolean }>().deduped).toBe(true);
    expect(providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount).toBe(1);
  });
});

/*
 * Review finding F3 (deploy/WIRING.md §2): `actorId` used to come from the
 * REQUEST BODY, so any caller could attribute a send to another user. The
 * production composition root mounts auth globally, which sets `request.actor`;
 * these pin that the principal — never the payload — decides attribution.
 */
describe('POST /api/v1/emails/send — actor attribution (F3)', () => {
  /** Mount the route behind a preHandler that fakes an authenticated principal. */
  async function appAs(principalId: string): Promise<FastifyInstance> {
    const authed = Fastify({ logger: false });
    authed.addHook('preHandler', async (request) => {
      request.actor = { id: principalId, type: 'user' };
    });
    registerEmailSendRoutes(authed, { db: ctx.db, providerFor, cipher });
    await authed.ready();
    return authed;
  }

  const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    accountId,
    leadId: lead,
    to: ['dana@acme.test'],
    body: 'Hi',
    ...extra,
  });

  test('a spoofed body actorId is refused — a caller cannot send AS someone else', async () => {
    const other = await seedUser(ctx.db, { email: 'victim@example.com' });
    const authed = await appAs(rep);
    try {
      const res = await authed.inject({
        method: 'POST',
        url: '/api/v1/emails/send',
        payload: body({ actorId: other }),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
      // Nothing was sent on the victim's behalf.
      expect(providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount).toBe(0);
    } finally {
      await authed.close();
    }
  });

  test('the principal attributes the send when the body omits actorId', async () => {
    const authed = await appAs(rep);
    try {
      const res = await authed.inject({
        method: 'POST',
        url: '/api/v1/emails/send',
        payload: body(),
      });
      expect(res.statusCode).toBe(200);
      expect(
        (await activitiesFor(ctx.db, lead)).filter((a) => a.type === 'email_sent'),
      ).toHaveLength(1);
    } finally {
      await authed.close();
    }
  });

  test('a body actorId equal to the principal still works (no regression)', async () => {
    const authed = await appAs(rep);
    try {
      const res = await authed.inject({
        method: 'POST',
        url: '/api/v1/emails/send',
        payload: body({ actorId: rep }),
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await authed.close();
    }
  });

  // failure path: with no principal AND no body actorId there is nobody to
  // attribute to — refuse rather than invent one.
  test('no principal and no body actorId is a validation error', async () => {
    const res = await post(body());
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});
