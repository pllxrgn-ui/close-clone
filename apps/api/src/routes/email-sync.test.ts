import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { emailAccounts, emailMessages, webhookInbox } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { MockEmailProvider } from '../providers/mock/mock-email-provider.ts';
import { MockGmailPushVerifier } from '../services/sync/webhook.ts';
import { TokenCipher } from '../services/sync/token-cipher.ts';
import { seedUser } from '../services/sync/test-support.ts';
import { registerEmailSyncRoutes } from './email-sync.ts';

/**
 * Email sync HTTP surface (CONTRACTS §C7): the OAuth link flow end-to-end under
 * MOCK_MODE (start → callback → backfilled+LIVE) and the `/wh/gmail` ingress
 * (verify → persist → fast-200; unverified → 401). Everything runs against a real
 * PGlite DB + MockEmailProvider — zero external accounts.
 */

const ADDRESS = 'rep@mock.test';

let ctx: TestDb;
let app: FastifyInstance;
let provider: MockEmailProvider;
let userId: string;

function pushBody(historyId: string, messageId: string): Record<string, unknown> {
  const data = Buffer.from(JSON.stringify({ emailAddress: ADDRESS, historyId })).toString('base64');
  return {
    message: { data, messageId, publishTime: '2026-01-02T09:00:00.000Z' },
    subscription: 'projects/switchboard/subscriptions/gmail-push',
  };
}

beforeEach(async () => {
  ctx = await createTestDb();
  provider = new MockEmailProvider({ address: ADDRESS });
  userId = await seedUser(ctx.db);
  app = Fastify({ logger: false });
  registerEmailSyncRoutes(app, {
    db: ctx.db,
    provider,
    cipher: new TokenCipher('route-suite-secret'),
    verifier: new MockGmailPushVerifier(),
    redirectUri: 'https://app.test/cb',
    providerName: 'mock',
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await ctx.close();
});

describe('OAuth link flow', () => {
  test('start → callback links, backfills, and reaches LIVE', async () => {
    // Two messages already in the mailbox at link time.
    provider.injectIncoming({ from: 'a@ext.test', subject: 'Hi' }, provider.nextHistoryId());
    provider.injectIncoming({ from: 'b@ext.test', subject: 'Yo' }, provider.nextHistoryId());

    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/gmail/start',
      payload: { userId, address: ADDRESS },
    });
    expect(start.statusCode).toBe(200);
    const { accountId, authUrl } = start.json<{ accountId: string; authUrl: string }>();
    expect(authUrl).toContain('mock.local/oauth/authorize');

    // Account is AUTHORIZING after start, with no tokens yet.
    const mid = await ctx.db.select().from(emailAccounts).where(eq(emailAccounts.id, accountId));
    expect(mid[0]!.syncStatus).toBe('AUTHORIZING');
    expect(mid[0]!.oauthTokens).toBeNull();

    const cb = await app.inject({
      method: 'GET',
      url: `/api/v1/oauth/gmail/callback?code=auth-code&state=${accountId}`,
    });
    expect(cb.statusCode).toBe(200);
    expect(cb.json<{ status: string }>().status).toBe('LIVE');

    const row = await ctx.db.select().from(emailAccounts).where(eq(emailAccounts.id, accountId));
    expect(row[0]!.syncStatus).toBe('LIVE');
    expect(row[0]!.oauthTokens).not.toBeNull();
    expect(row[0]!.oauthTokens!.startsWith('v1.')).toBe(true); // encrypted at rest
    expect(row[0]!.historyCursor).toBe(String(provider.headHistoryId));

    const msgs = await ctx.db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.accountId, accountId));
    expect(msgs).toHaveLength(2);
  });

  test('start rejects a malformed body with VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/gmail/start',
      payload: { address: ADDRESS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  test('callback with a non-uuid state is VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/oauth/gmail/callback?code=x&state=not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('/wh/gmail ingress', () => {
  test('verifies, persists raw, and fast-200s', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wh/gmail',
      headers: { 'x-goog-channel-token': 'tok' },
      payload: pushBody('2001', 'evt-abc'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);

    const rows = await ctx.db
      .select({ id: webhookInbox.id, processedAt: webhookInbox.processedAt })
      .from(webhookInbox)
      .where(eq(webhookInbox.providerEventId, 'evt-abc'));
    expect(rows).toHaveLength(1);
    // Route only persists; processing (and thus processed_at) is a separate step.
    expect(rows[0]!.processedAt).toBeNull();
  });

  test('a duplicate delivery still 200s and stores one row', async () => {
    const payload = pushBody('2002', 'evt-dup');
    await app.inject({ method: 'POST', url: '/wh/gmail', payload });
    const second = await app.inject({ method: 'POST', url: '/wh/gmail', payload });
    expect(second.statusCode).toBe(200);
    const rows = await ctx.db
      .select({ id: webhookInbox.id })
      .from(webhookInbox)
      .where(eq(webhookInbox.providerEventId, 'evt-dup'));
    expect(rows).toHaveLength(1);
  });

  test('an unverifiable body is rejected 401 and stored nowhere', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wh/gmail',
      payload: { not: 'a push' },
    });
    expect(res.statusCode).toBe(401);
    const rows = await ctx.db.select({ id: webhookInbox.id }).from(webhookInbox);
    expect(rows).toHaveLength(0);
  });
});
