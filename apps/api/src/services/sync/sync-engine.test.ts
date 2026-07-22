import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import type {
  EmailProvider,
  HistoryPage,
  MessagePage,
  OAuthTokens,
  RawEmail,
} from '@switchboard/shared/providers';
import { emailAccounts, emailMessages } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { MockEmailProvider } from '../../providers/mock/mock-email-provider.ts';
import { backfillStep, runBackfill } from './backfill.ts';
import { incrementalPull } from './incremental.ts';
import { SyncStateService } from './state.ts';
import { backfillCheckpointSchema, type SyncEngineDeps } from './engine-deps.ts';
import { makeCipher, makeEngine, seedAccount, seedUser } from './test-support.ts';

/**
 * Backfill + incremental pull (CONTRACTS §C5, ARCHITECTURE §3). Drives the
 * provider-agnostic engine with MockEmailProvider: checkpoint/resume (never
 * restarts), transactional cursor advance, and the HistoryExpired→RESYNC path.
 */

/** Delegating provider that counts `getMessage` calls (proves no re-fetch). */
class CountingProvider implements EmailProvider {
  getMessageCalls = 0;
  constructor(private readonly inner: MockEmailProvider) {}
  getAuthUrl(a: string, r: string): Promise<string> {
    return this.inner.getAuthUrl(a, r);
  }
  getMailboxAddress(tokens: OAuthTokens): Promise<string> {
    return this.inner.getMailboxAddress(tokens);
  }
  exchangeCode(c: string, r: string): Promise<OAuthTokens> {
    return this.inner.exchangeCode(c, r);
  }
  listHistory(t: OAuthTokens, c: string): Promise<HistoryPage> {
    return this.inner.listHistory(t, c);
  }
  listMessages(t: OAuthTokens, p?: string): Promise<MessagePage> {
    return this.inner.listMessages(t, p);
  }
  getMessage(t: OAuthTokens, id: string): Promise<RawEmail> {
    this.getMessageCalls += 1;
    return this.inner.getMessage(t, id);
  }
  send(t: OAuthTokens, d: Parameters<EmailProvider['send']>[1], k: string) {
    return this.inner.send(t, d, k);
  }
  watch(t: OAuthTokens, u: string): Promise<{ expiresAt: string }> {
    return this.inner.watch(t, u);
  }
}

let ctx: TestDb;
let mock: MockEmailProvider;
let accountId: string;

async function setupLinkedAccount(
  status: (typeof emailAccounts.$inferInsert)['syncStatus'] = 'BACKFILLING',
  backfillPageSize = 2,
): Promise<void> {
  mock = new MockEmailProvider({ address: 'rep@mock.test', backfillPageSize });
  const userId = await seedUser(ctx.db);
  const encrypted = makeCipher().encrypt(mock.mintTokens());
  accountId = await seedAccount(ctx.db, {
    userId,
    address: 'rep@mock.test',
    syncStatus: status,
    encryptedTokens: encrypted,
  });
}

function injectMany(count: number): void {
  for (let i = 0; i < count; i += 1) {
    mock.injectIncoming(
      { from: `sender${i}@ext.test`, subject: `Subject ${i}`, bodyText: `body ${i}` },
      mock.nextHistoryId(),
    );
  }
}

async function messageCount(): Promise<number> {
  const rows = await ctx.db
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(eq(emailMessages.accountId, accountId));
  return rows.length;
}

async function accountRow() {
  const rows = await ctx.db.select().from(emailAccounts).where(eq(emailAccounts.id, accountId));
  return rows[0]!;
}

beforeEach(async () => {
  ctx = await createTestDb();
});

afterEach(async () => {
  await ctx.close();
});

describe('backfill', () => {
  test('imports the full mailbox, then goes LIVE with the head as cursor', async () => {
    await setupLinkedAccount();
    injectMany(5);
    const engine = makeEngine(ctx.db, mock);

    const total = await runBackfill(engine, accountId);
    expect(total).toBe(5);
    expect(await messageCount()).toBe(5);

    const row = await accountRow();
    expect(row.syncStatus).toBe('LIVE');
    expect(row.historyCursor).toBe(String(mock.headHistoryId));
    expect(row.backfillCheckpoint).toBeNull();
  });

  test('checkpoints per page and resumes without re-fetching completed pages', async () => {
    await setupLinkedAccount('BACKFILLING', 2);
    injectMany(5); // 3 pages at size 2 (2 + 2 + 1)
    const counter = new CountingProvider(mock);
    const engine = makeEngine(ctx.db, counter);

    // One page only: simulate a crash after the first page committed.
    const step = await backfillStep(engine, accountId);
    expect(step.done).toBe(false);
    expect(await messageCount()).toBe(2);
    const mid = await accountRow();
    const cp = backfillCheckpointSchema.parse(mid.backfillCheckpoint);
    expect(cp.importedCount).toBe(2);
    expect(cp.pageToken).toBeDefined();
    expect(counter.getMessageCalls).toBe(2);

    // Resume to completion: the first two messages are NOT fetched again.
    const total = await runBackfill(engine, accountId);
    expect(total).toBe(5);
    expect(await messageCount()).toBe(5);
    expect(counter.getMessageCalls).toBe(5); // 5 total, never 7 → no restart
    expect((await accountRow()).syncStatus).toBe('LIVE');
  });
});

describe('incremental pull', () => {
  test('applies new adds and advances the cursor; replay is a no-op', async () => {
    await setupLinkedAccount();
    injectMany(2);
    const engine = makeEngine(ctx.db, mock);
    await runBackfill(engine, accountId);
    const cursorAfterBackfill = (await accountRow()).historyCursor;

    // Two messages arrive after backfill (push).
    injectMany(2);
    const pull = await incrementalPull(engine, accountId);
    expect(pull.resynced).toBe(false);
    expect(pull.messagesApplied).toBe(2);
    expect(await messageCount()).toBe(4);

    const row = await accountRow();
    expect(row.historyCursor).toBe(String(mock.headHistoryId));
    expect(row.historyCursor).not.toBe(cursorAfterBackfill);

    // Replaying the same pull imports nothing (dedupe + monotonic cursor).
    const replay = await incrementalPull(engine, accountId);
    expect(replay.messagesApplied).toBe(0);
    expect(await messageCount()).toBe(4);
  });

  test('HistoryExpiredError drives RESYNC → re-backfill → LIVE, wiping nothing', async () => {
    await setupLinkedAccount();
    injectMany(3);
    const engine = makeEngine(ctx.db, mock);
    await runBackfill(engine, accountId);
    const cursorBefore = (await accountRow()).historyCursor!;

    // A message arrives, then history is expired past the stored cursor.
    injectMany(1);
    mock.expireHistoryBefore(Number(cursorBefore) + 1);

    const pull = await incrementalPull(engine, accountId);
    expect(pull.resynced).toBe(true);
    // Nothing wiped; the gap message is recovered by the dedupe re-backfill.
    expect(await messageCount()).toBe(4);

    const row = await accountRow();
    expect(row.syncStatus).toBe('LIVE');
    expect(row.historyCursor).toBe(String(mock.headHistoryId));
    expect(row.backfillCheckpoint).toBeNull();
  });
});

describe('failure paths', () => {
  test('incremental pull without a cursor throws', async () => {
    await setupLinkedAccount('LIVE');
    const engine: SyncEngineDeps = makeEngine(ctx.db, mock);
    await expect(incrementalPull(engine, accountId)).rejects.toThrow(/history cursor/);
  });

  test('loading an account with no stored tokens requires re-auth', async () => {
    const localMock = new MockEmailProvider({ address: 'rep@mock.test' });
    const userId = await seedUser(ctx.db);
    const noTokenAccount = await seedAccount(ctx.db, {
      userId,
      syncStatus: 'BACKFILLING',
      encryptedTokens: null,
    });
    const engine = makeEngine(ctx.db, localMock);
    await expect(runBackfill(engine, noTokenAccount)).rejects.toThrow(/re-authentication/);
  });

  test('a new SyncStateService instance reads persisted state', async () => {
    await setupLinkedAccount('LIVE');
    const svc = new SyncStateService(ctx.db);
    expect(await svc.current(accountId)).toBe('LIVE');
  });
});
