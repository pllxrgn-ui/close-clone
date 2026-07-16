import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { AmbiguousLeadMatcher } from '../sync/matcher.ts';
import { normalizeSubject, participantsOf, computeIdSet } from './threading.ts';
import {
  ingest,
  makeRaw,
  seedAccount,
  seedUser,
  threadsFor,
  type ThreadSnapshot,
} from './test-helpers.ts';

/**
 * Threading (task 2c, CONTRACTS §C1/§C5): RFC 5322 Message-ID/References/
 * In-Reply-To linkage first, normalized-subject + participant-set fallback
 * second, and determinism regardless of arrival order.
 */

const deps = { matcher: new AmbiguousLeadMatcher() };

let ctx: TestDb;
let accountId: string;

beforeEach(async () => {
  ctx = await createTestDb();
  const userId = await seedUser(ctx.db);
  accountId = await seedAccount(ctx.db, userId);
}, 60_000);
afterEach(async () => {
  await ctx.close();
});

/** Thread snapshot minus the row uuid — the arrival-order-independent shape. */
function shape(snaps: ThreadSnapshot[]): Omit<ThreadSnapshot, 'id'>[] {
  return snaps.map(({ id: _id, ...rest }) => rest);
}

describe('pure helpers', () => {
  test('normalizeSubject strips repeated Re:/Fwd:/Fw: and lowercases', () => {
    expect(normalizeSubject('Re: Fwd: Re:  Hello World')).toBe('hello world');
    expect(normalizeSubject('FW: Quote')).toBe('quote');
    expect(normalizeSubject(null)).toBe('');
    expect(normalizeSubject('  Plain  ')).toBe('plain');
  });

  test('participantsOf dedupes and sorts from+to+cc', () => {
    expect(participantsOf('a@x', ['b@x', 'a@x'], ['c@x'])).toEqual(['a@x', 'b@x', 'c@x']);
  });

  test('computeIdSet unions rfc + inReplyTo + references, dropping blanks', () => {
    const raw = makeRaw({ rfcMessageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>', ''] });
    expect(computeIdSet(raw).sort()).toEqual(['<a@x>', '<b@x>']);
  });
});

describe('RFC 5322 linkage', () => {
  test('In-Reply-To joins the parent thread', async () => {
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', threadId: 'p-1', subject: 'Intro' }),
    );
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<b@x>', threadId: 'p-9', subject: 'Re: Intro', inReplyTo: '<a@x>' }),
    );
    const threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messageRfcIds).toEqual(['<a@x>', '<b@x>']);
  });

  test('References joins even when subject and participants differ', async () => {
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Alpha' }),
    );
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({
        rfcMessageId: '<b@x>',
        from: 'zzz@other.test',
        subject: 'Totally Different',
        references: ['<a@x>'],
      }),
    );
    const threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messageRfcIds).toEqual(['<a@x>', '<b@x>']);
  });

  test('reply arriving BEFORE its parent still unifies once the parent lands', async () => {
    // Reply first (references a parent not yet seen).
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<b@x>', subject: 'Re: Intro', references: ['<a@x>'] }),
    );
    let threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1); // lone reply, its own thread for now
    // Parent lands; symmetric linkage unifies them.
    await ingest(ctx.db, deps, accountId, makeRaw({ rfcMessageId: '<a@x>', subject: 'Intro' }));
    threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messageRfcIds).toEqual(['<a@x>', '<b@x>']);
  });

  test('a bridging message MERGES two previously separate threads', async () => {
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Alpha' }),
    );
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<c@x>', from: 'c@ext.test', subject: 'Gamma' }),
    );
    expect(await threadsFor(ctx.db, accountId)).toHaveLength(2);
    // B references BOTH — the two threads collapse into one.
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({
        rfcMessageId: '<b@x>',
        from: 'b@ext.test',
        subject: 'Re: Alpha',
        references: ['<a@x>', '<c@x>'],
      }),
    );
    const threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messageRfcIds).toEqual(['<a@x>', '<b@x>', '<c@x>']);
  });
});

describe('subject + participant fallback', () => {
  test('same normalized subject AND participant set groups without RFC linkage', async () => {
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Intro' }),
    );
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<b@x>', from: 'a@ext.test', subject: 'Re: Intro' }),
    );
    const threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.subjectNorm).toBe('intro');
  });

  test('same subject but DIFFERENT participants stays separate', async () => {
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Intro' }),
    );
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<b@x>', from: 'b@ext.test', subject: 'Intro' }),
    );
    expect(await threadsFor(ctx.db, accountId)).toHaveLength(2);
  });

  test('same participants but DIFFERENT subject stays separate', async () => {
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', from: 'a@ext.test', subject: 'Intro' }),
    );
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<b@x>', from: 'a@ext.test', subject: 'Pricing' }),
    );
    expect(await threadsFor(ctx.db, accountId)).toHaveLength(2);
  });
});

describe('determinism + provider-thread folding', () => {
  test('provider_thread_id folds to LEAST across a fallback-grouped thread', async () => {
    // Two messages the provider split (different thread ids) but that fallback-group.
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({ rfcMessageId: '<a@x>', threadId: 't-zzz', from: 'a@ext.test', subject: 'Intro' }),
    );
    await ingest(
      ctx.db,
      deps,
      accountId,
      makeRaw({
        rfcMessageId: '<b@x>',
        threadId: 't-aaa',
        from: 'a@ext.test',
        subject: 'Re: Intro',
      }),
    );
    const threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.providerThreadId).toBe('t-aaa'); // least of {t-aaa, t-zzz}
  });

  test('final grouping is identical regardless of arrival order', async () => {
    const raws = [
      makeRaw({ rfcMessageId: '<a@x>', threadId: 't-1', from: 'a@ext.test', subject: 'Intro' }),
      makeRaw({
        rfcMessageId: '<b@x>',
        threadId: 't-1b',
        from: 'a@ext.test',
        subject: 'Re: Intro',
      }),
      makeRaw({ rfcMessageId: '<c@x>', threadId: 't-2', from: 'c@ext.test', subject: 'Quote' }),
      makeRaw({
        rfcMessageId: '<d@x>',
        threadId: 't-3',
        from: 'd@ext.test',
        subject: 'Demo',
        references: ['<c@x>'],
      }),
    ];

    // Order 1: natural.
    for (const r of raws) await ingest(ctx.db, deps, accountId, r);
    const natural = shape(await threadsFor(ctx.db, accountId));

    // Order 2: reversed, fresh DB + account.
    const ctx2 = await createTestDb();
    try {
      const u2 = await seedUser(ctx2.db, { email: 'rep-shuffle@example.com' });
      const acc2 = await seedAccount(ctx2.db, u2);
      for (const r of [raws[3]!, raws[1]!, raws[2]!, raws[0]!])
        await ingest(ctx2.db, deps, acc2, r);
      const reversed = shape(await threadsFor(ctx2.db, acc2));
      expect(reversed).toEqual(natural);
    } finally {
      await ctx2.close();
    }
  });
});

describe('dedupe', () => {
  test('re-ingesting the same rfc id inserts no new message or thread', async () => {
    const raw = makeRaw({ rfcMessageId: '<a@x>', subject: 'Intro' });
    const first = await ingest(ctx.db, deps, accountId, raw);
    expect(first.inserted).toBe(true);
    const second = await ingest(ctx.db, deps, accountId, raw);
    expect(second.inserted).toBe(false);
    expect(second.threadId).toBe(first.threadId);
    expect(await threadsFor(ctx.db, accountId)).toHaveLength(1);
  });
});
