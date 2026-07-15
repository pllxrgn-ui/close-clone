import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { emailMessages, webhookInbox } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { MockEmailProvider } from '../../providers/mock/mock-email-provider.ts';
import { runBackfill } from './backfill.ts';
import {
  InvalidPushError,
  MockGmailPushVerifier,
  parseGmailPush,
  persistGmailPush,
  processGmailInboxRow,
} from './webhook.ts';
import { makeCipher, makeEngine, seedAccount, seedUser } from './test-support.ts';

/**
 * `/wh/gmail` ingress (CONTRACTS §C7, ARCHITECTURE §5): parse + verify the push,
 * persist raw to `webhook_inbox` (unique event id ⇒ replay no-op), and process it
 * as a SEPARATE idempotent step that drives an incremental pull exactly once.
 */

const fixturesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../fixtures/webhooks/gmail',
);

interface Fixture {
  eventId: string;
  headers: Record<string, string>;
  rawBody: string;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8')) as Fixture;
}

let ctx: TestDb;

beforeEach(async () => {
  ctx = await createTestDb();
});
afterEach(async () => {
  await ctx.close();
});

describe('parseGmailPush', () => {
  test('decodes the recorded fixture envelope + notification', () => {
    const fx = loadFixture('0001-history-advance.json');
    const parsed = parseGmailPush(fx.rawBody);
    expect(parsed.eventId).toBe('pubsub-msg-0001');
    expect(parsed.notification.emailAddress).toBe('rep@mock.test');
    expect(parsed.notification.historyId).toBe('1001');
  });

  test('rejects non-JSON, non-envelope, and bad base64 payloads', () => {
    expect(() => parseGmailPush('not json')).toThrow(InvalidPushError);
    expect(() => parseGmailPush('{"foo":1}')).toThrow(InvalidPushError);
    expect(() =>
      parseGmailPush(JSON.stringify({ message: { data: '@@@', messageId: 'x' } })),
    ).toThrow(InvalidPushError);
  });
});

describe('MockGmailPushVerifier', () => {
  test('accepts a structurally valid push, rejects garbage', () => {
    const fx = loadFixture('0001-history-advance.json');
    const v = new MockGmailPushVerifier();
    expect(v.verify(fx.headers, fx.rawBody)).toBe(true);
    expect(v.verify(fx.headers, 'garbage')).toBe(false);
  });

  test('enforces a required shared token when configured', () => {
    const fx = loadFixture('0001-history-advance.json');
    const v = new MockGmailPushVerifier({ requiredToken: 'mock-channel-token' });
    expect(v.verify(fx.headers, fx.rawBody)).toBe(true);
    expect(v.verify({ ...fx.headers, 'x-goog-channel-token': 'wrong' }, fx.rawBody)).toBe(false);
  });
});

describe('persistGmailPush dedupe', () => {
  test('stores once; a duplicate event id no-ops', async () => {
    const parsed = parseGmailPush(loadFixture('0001-history-advance.json').rawBody);
    const first = await persistGmailPush(ctx.db, parsed);
    expect(first.stored).toBe(true);
    const second = await persistGmailPush(ctx.db, parsed);
    expect(second.stored).toBe(false);

    const rows = await ctx.db
      .select({ id: webhookInbox.id })
      .from(webhookInbox)
      .where(eq(webhookInbox.providerEventId, 'pubsub-msg-0001'));
    expect(rows).toHaveLength(1);
  });
});

describe('processGmailInboxRow', () => {
  async function setupLiveAccount(provider: MockEmailProvider): Promise<string> {
    const userId = await seedUser(ctx.db);
    const encrypted = makeCipher().encrypt(provider.mintTokens());
    const accountId = await seedAccount(ctx.db, {
      userId,
      address: 'rep@mock.test',
      syncStatus: 'BACKFILLING',
      encryptedTokens: encrypted,
    });
    await runBackfill(makeEngine(ctx.db, provider), accountId);
    return accountId;
  }

  test('drives one pull, stamps processed_at, and is idempotent on replay', async () => {
    const provider = new MockEmailProvider({ address: 'rep@mock.test' });
    const engine = makeEngine(ctx.db, provider);
    const accountId = await setupLiveAccount(provider);

    // A message arrives; the push tells us to pull.
    provider.injectIncoming({ from: 'x@ext.test', subject: 'New' }, provider.nextHistoryId());
    const parsed = parseGmailPush(loadFixture('0001-history-advance.json').rawBody);
    const { inboxId } = await persistGmailPush(engine.db, parsed);

    const first = await processGmailInboxRow(engine, inboxId!);
    expect(first.alreadyProcessed).toBe(false);
    expect(first.accountId).toBe(accountId);
    expect(first.pulled).toBe(true);
    const afterFirst = await ctx.db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.accountId, accountId));
    expect(afterFirst).toHaveLength(1);

    // Re-processing the same inbox row does nothing.
    const second = await processGmailInboxRow(engine, inboxId!);
    expect(second.alreadyProcessed).toBe(true);
    const afterSecond = await ctx.db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.accountId, accountId));
    expect(afterSecond).toHaveLength(1);
  });

  test('an unknown mailbox is recorded (processed with error), not retried', async () => {
    const engine = makeEngine(ctx.db, new MockEmailProvider({ address: 'nobody@mock.test' }));
    // Notification addresses rep@mock.test, but no such account exists.
    const parsed = parseGmailPush(loadFixture('0001-history-advance.json').rawBody);
    const { inboxId } = await persistGmailPush(engine.db, parsed);

    const res = await processGmailInboxRow(engine, inboxId!);
    expect(res.accountId).toBeNull();
    expect(res.pulled).toBe(false);
    const row = await ctx.db
      .select({ processedAt: webhookInbox.processedAt, error: webhookInbox.error })
      .from(webhookInbox)
      .where(eq(webhookInbox.id, inboxId!));
    expect(row[0]!.processedAt).not.toBeNull();
    expect(row[0]!.error).toContain('no mailbox');
  });
});
