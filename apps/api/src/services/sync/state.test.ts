import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { emailAccounts, syncEvents } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { SyncStateService, isLegalTransition } from './state.ts';
import { AccountNotFoundError, IllegalTransitionError, type SyncStatus } from './errors.ts';
import { seedAccount, seedUser } from './test-support.ts';

/**
 * C5 state machine (CONTRACTS §C5). The service is the SOLE mutator of
 * `sync_status`; every transition is validated against the C5 adjacency and
 * appended to `sync_events`. Illegal transitions are refused and write nothing.
 */

let ctx: TestDb;
let svc: SyncStateService;
let accountId: string;

beforeEach(async () => {
  ctx = await createTestDb();
  svc = new SyncStateService(ctx.db);
  const userId = await seedUser(ctx.db);
  accountId = await seedAccount(ctx.db, { userId, syncStatus: 'UNLINKED' });
});

afterEach(async () => {
  await ctx.close();
});

async function forceState(to: SyncStatus): Promise<void> {
  await ctx.db.update(emailAccounts).set({ syncStatus: to }).where(eq(emailAccounts.id, accountId));
}

async function eventCount(): Promise<number> {
  const rows = await ctx.db.select({ id: syncEvents.id }).from(syncEvents);
  return rows.length;
}

// The full C5 adjacency, encoded once as the oracle for the property checks.
const LEGAL: ReadonlyArray<[SyncStatus, SyncStatus]> = [
  ['UNLINKED', 'AUTHORIZING'],
  ['AUTHORIZING', 'BACKFILLING'],
  ['BACKFILLING', 'LIVE'],
  ['LIVE', 'DEGRADED'],
  ['DEGRADED', 'LIVE'],
  ['LIVE', 'RESYNC'],
  ['RESYNC', 'LIVE'],
  ['REAUTH_REQUIRED', 'AUTHORIZING'],
];
const ALL_STATES: readonly SyncStatus[] = [
  'UNLINKED',
  'AUTHORIZING',
  'BACKFILLING',
  'LIVE',
  'DEGRADED',
  'RESYNC',
  'REAUTH_REQUIRED',
];

describe('isLegalTransition (C5 oracle)', () => {
  test('accepts exactly the listed edges plus any→REAUTH_REQUIRED', () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const expected =
          (to === 'REAUTH_REQUIRED' && from !== 'REAUTH_REQUIRED') ||
          LEGAL.some(([f, t]) => f === from && t === to);
        expect(isLegalTransition(from, to)).toBe(expected);
      }
    }
  });

  test('self-transitions are illegal for every state', () => {
    for (const s of ALL_STATES) expect(isLegalTransition(s, s)).toBe(false);
  });
});

describe('SyncStateService.transition', () => {
  test('a legal transition updates status and appends a sync_events row', async () => {
    const res = await svc.transition(accountId, 'AUTHORIZING', 'oauth:start');
    expect(res).toEqual({ from: 'UNLINKED', to: 'AUTHORIZING' });
    expect(await svc.current(accountId)).toBe('AUTHORIZING');

    const events = await ctx.db
      .select()
      .from(syncEvents)
      .where(eq(syncEvents.accountId, accountId))
      .orderBy(asc(syncEvents.at));
    expect(events).toHaveLength(1);
    expect(events[0]!.fromState).toBe('UNLINKED');
    expect(events[0]!.toState).toBe('AUTHORIZING');
    expect(events[0]!.cause).toBe('oauth:start');
  });

  test('walks the happy path UNLINKED→AUTHORIZING→BACKFILLING→LIVE⇄DEGRADED', async () => {
    await svc.transition(accountId, 'AUTHORIZING', 'c');
    await svc.transition(accountId, 'BACKFILLING', 'c');
    await svc.transition(accountId, 'LIVE', 'c');
    await svc.transition(accountId, 'DEGRADED', 'c');
    await svc.transition(accountId, 'LIVE', 'c');
    await svc.transition(accountId, 'RESYNC', 'c');
    await svc.transition(accountId, 'LIVE', 'c');
    expect(await svc.current(accountId)).toBe('LIVE');
    expect(await eventCount()).toBe(7);
  });

  test('REAUTH_REQUIRED is reachable from any state, then only AUTHORIZING', async () => {
    for (const from of ['AUTHORIZING', 'BACKFILLING', 'LIVE', 'DEGRADED', 'RESYNC'] as const) {
      await forceState(from);
      const r = await svc.transition(accountId, 'REAUTH_REQUIRED', 'token:revoked');
      expect(r).toEqual({ from, to: 'REAUTH_REQUIRED' });
    }
    // From REAUTH_REQUIRED the only legal move is AUTHORIZING.
    await svc.transition(accountId, 'AUTHORIZING', 'relink');
    expect(await svc.current(accountId)).toBe('AUTHORIZING');
  });

  test('an illegal transition throws and writes nothing', async () => {
    await forceState('LIVE');
    const before = await eventCount();
    await expect(svc.transition(accountId, 'AUTHORIZING', 'nope')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    expect(await svc.current(accountId)).toBe('LIVE');
    expect(await eventCount()).toBe(before);
  });

  test('a self-transition is refused', async () => {
    await forceState('LIVE');
    await expect(svc.transition(accountId, 'LIVE', 'noop')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  test('transition on a missing account throws AccountNotFoundError', async () => {
    await expect(
      svc.transition('00000000-0000-4000-8000-000000000000', 'AUTHORIZING', 'x'),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});
