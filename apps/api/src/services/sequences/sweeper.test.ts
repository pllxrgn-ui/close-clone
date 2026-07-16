import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { sendIntents } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { MockEmailProvider } from '../../providers/mock/mock-email-provider.ts';
import { SyncStateService } from '../sync/state.ts';
import { makeCipher, makeEngine, seedAccount as seedSyncAccount, seedUser as seedSyncUser } from '../sync/test-support.ts';
import { enrollContacts } from './enrollment.ts';
import { expireStaleClaims, recoverResyncAccounts, sweepDueIntents, type SweeperDeps } from './sweeper.ts';
import {
  intentState,
  intentsForEnrollment,
  makeHarness,
  seedAccount,
  seedContact,
  seedLead,
  seedSequence,
  seedTemplate,
  seedUser,
  setOrgSettings,
  type EngineHarness,
} from './test-helpers.ts';

/**
 * The sweeper (ARCHITECTURE §4.2/§4.3): due-intent self-heal, CLAIMED→FAILED_TIMEOUT
 * crash expiry (never auto-re-sent), and RESYNC crash-recovery via runBackfill
 * (the 2b note / DECISIONS D-023).
 */

let ctx: TestDb;
let h: EngineHarness;
let rep: string;
let lead: string;
let contact: string;
let account: string;
let template: string;

function sweeperDeps(claimTimeoutMs: number): SweeperDeps {
  return { db: ctx.db, queue: h.queue, now: h.deps.now, claimTimeoutMs };
}

async function enrollIntent(): Promise<string> {
  const { sequenceId } = await seedSequence(ctx.db, [{ type: 'email', delayHours: 0, templateId: template }]);
  const res = await enrollContacts(h.deps, {
    sequenceId,
    enrolledBy: rep,
    emailAccountId: account,
    targets: [{ leadId: lead, contactId: contact }],
  });
  return (await intentsForEnrollment(ctx.db, res.enrolled[0]!.enrollmentId))[0]!.id;
}

beforeEach(async () => {
  ctx = await createTestDb();
  h = makeHarness(ctx.db);
  rep = await seedUser(ctx.db, 'rep@switchboard.test');
  lead = await seedLead(ctx.db, 'Acme');
  contact = await seedContact(ctx.db, lead, 'dana@acme.test');
  account = await seedAccount(ctx.db, h.cipher, rep, 'rep@mock.test');
  template = await seedTemplate(ctx.db);
  await setOrgSettings(ctx.db, {});
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('sweepDueIntents', () => {
  test('finds and enqueues due SCHEDULED intents, ignoring future ones', async () => {
    await enrollIntent(); // due now
    const future = await enrollIntent();
    const soon = new Date(h.clock.now.getTime() + 3_600_000).toISOString();
    await ctx.db.update(sendIntents).set({ dueAt: soon }).where(eq(sendIntents.id, future));

    // Only the due intent is swept (the sweep dedupes on jobId, so re-running is safe).
    expect(await sweepDueIntents(sweeperDeps(300_000))).toBe(1);
    expect(await sweepDueIntents(sweeperDeps(300_000))).toBe(1);
  });
});

describe('expireStaleClaims', () => {
  test('a CLAIMED intent older than the timeout becomes FAILED_TIMEOUT; fresh ones survive', async () => {
    const stale = await enrollIntent();
    const fresh = await enrollIntent();
    const nowMs = h.clock.now.getTime();
    // Stale: claimed 10 min ago; fresh: claimed just now.
    await ctx.db
      .update(sendIntents)
      .set({ state: 'CLAIMED', claimedAt: new Date(nowMs - 600_000).toISOString() })
      .where(eq(sendIntents.id, stale));
    await ctx.db
      .update(sendIntents)
      .set({ state: 'CLAIMED', claimedAt: new Date(nowMs).toISOString() })
      .where(eq(sendIntents.id, fresh));

    const expired = await expireStaleClaims(sweeperDeps(300_000)); // 5-min timeout
    expect(expired).toEqual([stale]);
    expect((await intentState(ctx.db, stale)).state).toBe('FAILED_TIMEOUT');
    expect((await intentState(ctx.db, stale)).skipReason).toBe('claim_timeout');
    expect((await intentState(ctx.db, fresh)).state).toBe('CLAIMED');
    // Never auto-re-sent: no provider delivery resulted from the expiry.
    expect(h.providers.get('rep@mock.test')?.deliveredCount ?? 0).toBe(0);
  });
});

describe('RESYNC crash-recovery', () => {
  test('an account stuck in RESYNC is re-driven via runBackfill to LIVE', async () => {
    const cipher = makeCipher();
    const provider = new MockEmailProvider({ address: 'resync@mock.test' });
    // Two messages waiting in the mailbox to be (re-)backfilled.
    provider.injectIncoming({ from: 'a@ext.test', subject: 'One' }, provider.nextHistoryId());
    provider.injectIncoming({ from: 'b@ext.test', subject: 'Two' }, provider.nextHistoryId());

    const syncUser = await seedSyncUser(ctx.db, 'sync@switchboard.test');
    const acct = await seedSyncAccount(ctx.db, {
      userId: syncUser,
      address: 'resync@mock.test',
      syncStatus: 'RESYNC',
      encryptedTokens: cipher.encrypt(provider.mintTokens()),
    });
    const engine = makeEngine(ctx.db, provider);

    const recovered = await recoverResyncAccounts(engine);
    expect(recovered).toEqual([acct]);
    expect(await new SyncStateService(ctx.db).current(acct)).toBe('LIVE');

    const count = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM email_messages WHERE account_id = ${acct}`,
    );
    expect(Number((count as { rows: Record<string, unknown>[] }).rows[0]!['n'])).toBe(2);
  });
});
