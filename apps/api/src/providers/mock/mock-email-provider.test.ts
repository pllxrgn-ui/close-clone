import { beforeEach, describe, expect, test } from 'vitest';
import {
  HistoryExpiredError,
  MessageNotFoundError,
  oauthTokensSchema,
  type OAuthTokens,
  type OutboundEmail,
} from '@switchboard/shared/providers';
import { ManualClock } from './clock.ts';
import { MockEmailProvider } from './mock-email-provider.ts';

/** Drain all history pages from a cursor, returning the flattened net changes. */
async function drainHistory(provider: MockEmailProvider, tokens: OAuthTokens, startCursor: string) {
  const added: string[] = [];
  const deleted: string[] = [];
  const labelsChanged: string[] = [];
  let cursor = startCursor;
  let pages = 0;
  // Guard against runaway loops in a bug.
  for (let i = 0; i < 1000; i += 1) {
    const page = await provider.listHistory(tokens, cursor);
    pages += 1;
    added.push(...page.messagesAdded.map((m) => m.providerMessageId));
    deleted.push(...page.messagesDeleted.map((m) => m.providerMessageId));
    labelsChanged.push(...page.labelsChanged.map((m) => m.providerMessageId));
    cursor = page.historyId;
    if (page.nextPageToken === undefined) break;
  }
  return { added, deleted, labelsChanged, pages, cursor };
}

describe('MockEmailProvider', () => {
  let provider: MockEmailProvider;
  let tokens: OAuthTokens;

  beforeEach(() => {
    provider = new MockEmailProvider({ address: 'rep@mock.test', clock: new ManualClock() });
    tokens = provider.mintTokens();
  });

  test('mintTokens produces contract-valid OAuthTokens', () => {
    expect(() => oauthTokensSchema.parse(tokens)).not.toThrow();
  });

  describe('auth surface', () => {
    test('getAuthUrl embeds the hint and redirect', async () => {
      const url = await provider.getAuthUrl('rep@mock.test', 'https://app/cb');
      expect(url).toContain('login_hint=rep%40mock.test');
      expect(url).toContain('redirect_uri=https%3A%2F%2Fapp%2Fcb');
    });

    test('exchangeCode rejects empty code / redirect, else returns tokens', async () => {
      await expect(provider.exchangeCode('', 'https://app/cb')).rejects.toThrow();
      await expect(provider.exchangeCode('code', '')).rejects.toThrow();
      const t = await provider.exchangeCode('code', 'https://app/cb');
      expect(() => oauthTokensSchema.parse(t)).not.toThrow();
    });

    test('getMailboxAddress returns the authenticated mock mailbox', async () => {
      await expect(
        (
          provider as unknown as {
            getMailboxAddress(tokens: OAuthTokens): Promise<string>;
          }
        ).getMailboxAddress(tokens),
      ).resolves.toBe('rep@mock.test');
    });
  });

  describe('history semantics', () => {
    test('history ids are monotonically increasing across injects and sends', async () => {
      const base = provider.headHistoryId;
      provider.injectIncoming({ from: 'a@x.test', subject: 'one' }, provider.nextHistoryId());
      await provider.send(tokens, { to: ['a@x.test'], subject: 're' }, 'k1');
      provider.injectIncoming({ from: 'b@x.test', subject: 'two' }, provider.nextHistoryId());
      expect(provider.headHistoryId).toBeGreaterThan(base);
      // strictly increasing across the three mutations
      expect(provider.headHistoryId).toBe(base + 3);
    });

    test('injectIncoming rejects a non-increasing history id', () => {
      const at = provider.nextHistoryId();
      provider.injectIncoming({ from: 'a@x.test' }, at);
      expect(() => provider.injectIncoming({ from: 'b@x.test' }, at)).toThrow(/strictly greater/);
    });

    test('listHistory returns adds after the cursor only', async () => {
      const start = String(provider.headHistoryId);
      const first = provider.injectIncoming({ from: 'a@x.test' }, provider.nextHistoryId());
      const afterFirst = String(provider.headHistoryId);
      const second = provider.injectIncoming({ from: 'b@x.test' }, provider.nextHistoryId());

      const fromStart = await provider.listHistory(tokens, start);
      expect(fromStart.messagesAdded.map((m) => m.providerMessageId)).toEqual([
        first.providerMessageId,
        second.providerMessageId,
      ]);

      const fromMiddle = await provider.listHistory(tokens, afterFirst);
      expect(fromMiddle.messagesAdded.map((m) => m.providerMessageId)).toEqual([
        second.providerMessageId,
      ]);
    });

    test('COALESCES add + label change on the same message into one add', async () => {
      const start = String(provider.headHistoryId);
      const msg = provider.injectIncoming(
        { from: 'a@x.test', labels: ['INBOX'] },
        provider.nextHistoryId(),
      );
      provider.setLabels(msg.providerMessageId, ['INBOX', 'IMPORTANT'], provider.nextHistoryId());

      const page = await provider.listHistory(tokens, start);
      expect(page.messagesAdded).toHaveLength(1);
      expect(page.messagesAdded[0]?.providerMessageId).toBe(msg.providerMessageId);
      expect(page.messagesAdded[0]?.labels).toEqual(['INBOX', 'IMPORTANT']);
      // it's an add, not a separate labelsChanged entry
      expect(page.labelsChanged).toHaveLength(0);
    });

    test('COALESCES add + delete on the same message into nothing', async () => {
      const start = String(provider.headHistoryId);
      const msg = provider.injectIncoming({ from: 'a@x.test' }, provider.nextHistoryId());
      provider.deleteMessage(msg.providerMessageId, provider.nextHistoryId());

      const page = await provider.listHistory(tokens, start);
      expect(page.messagesAdded).toHaveLength(0);
      expect(page.messagesDeleted).toHaveLength(0);
    });

    test('label change on a pre-existing message surfaces as labelsChanged', async () => {
      const msg = provider.injectIncoming(
        { from: 'a@x.test', labels: ['INBOX'] },
        provider.nextHistoryId(),
      );
      const cursor = String(provider.headHistoryId); // after the add
      provider.setLabels(msg.providerMessageId, ['INBOX', 'STARRED'], provider.nextHistoryId());

      const page = await provider.listHistory(tokens, cursor);
      expect(page.messagesAdded).toHaveLength(0);
      expect(page.labelsChanged.map((m) => m.providerMessageId)).toEqual([msg.providerMessageId]);
      expect(page.labelsChanged[0]?.labels).toEqual(['INBOX', 'STARRED']);
    });

    test('delete of a pre-existing message surfaces as messagesDeleted', async () => {
      const msg = provider.injectIncoming({ from: 'a@x.test' }, provider.nextHistoryId());
      const cursor = String(provider.headHistoryId);
      provider.deleteMessage(msg.providerMessageId, provider.nextHistoryId());

      const page = await provider.listHistory(tokens, cursor);
      expect(page.messagesDeleted.map((m) => m.providerMessageId)).toEqual([msg.providerMessageId]);
      // and it is no longer fetchable
      await expect(provider.getMessage(tokens, msg.providerMessageId)).rejects.toBeInstanceOf(
        MessageNotFoundError,
      );
    });

    test('paginates history and cursor replay reaches the same net state (idempotent)', async () => {
      const paged = new MockEmailProvider({ historyPageSize: 3, clock: new ManualClock() });
      const t = paged.mintTokens();
      const start = String(paged.headHistoryId);
      const ids: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        ids.push(
          paged.injectIncoming({ from: `s${i}@x.test` }, paged.nextHistoryId()).providerMessageId,
        );
      }
      const drained = await drainHistory(paged, t, start);
      expect(drained.pages).toBeGreaterThan(1);
      expect(drained.added).toEqual(ids);

      // Replay from the same start again → identical adds (replays are no-ops
      // for the consumer; the provider is a pure function of its log).
      const replay = await drainHistory(paged, t, start);
      expect(replay.added).toEqual(ids);

      // From the caught-up cursor there is nothing new.
      const caughtUp = await paged.listHistory(t, drained.cursor);
      expect(caughtUp.messagesAdded).toHaveLength(0);
      expect(caughtUp.nextPageToken).toBeUndefined();
    });

    test('expired cursor throws HistoryExpiredError (RESYNC trigger)', async () => {
      const start = String(provider.headHistoryId);
      provider.injectIncoming({ from: 'a@x.test' }, provider.nextHistoryId());
      const floor = provider.headHistoryId;
      provider.injectIncoming({ from: 'b@x.test' }, provider.nextHistoryId());
      provider.expireHistoryBefore(floor);

      await expect(provider.listHistory(tokens, start)).rejects.toBeInstanceOf(HistoryExpiredError);
      // A cursor at/after the floor still works.
      await expect(provider.listHistory(tokens, String(floor))).resolves.toBeDefined();
    });
  });

  describe('backfill (listMessages)', () => {
    test('paginates all live messages and snapshots the head historyId', async () => {
      const paged = new MockEmailProvider({ backfillPageSize: 4, clock: new ManualClock() });
      const t = paged.mintTokens();
      const ids: string[] = [];
      for (let i = 0; i < 9; i += 1) {
        ids.push(
          paged.injectIncoming({ from: `s${i}@x.test` }, paged.nextHistoryId()).providerMessageId,
        );
      }
      const collected: string[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      for (let i = 0; i < 100; i += 1) {
        const page: Awaited<ReturnType<MockEmailProvider['listMessages']>> =
          pageToken === undefined
            ? await paged.listMessages(t)
            : await paged.listMessages(t, pageToken);
        pages += 1;
        collected.push(...page.messages.map((m) => m.providerMessageId));
        expect(page.historyId).toBe(String(paged.headHistoryId));
        if (page.nextPageToken === undefined) break;
        pageToken = page.nextPageToken;
      }
      expect(pages).toBe(3);
      expect(collected).toEqual(ids);
    });

    test('deleted messages drop out of backfill', async () => {
      const a = provider.injectIncoming({ from: 'a@x.test' }, provider.nextHistoryId());
      provider.injectIncoming({ from: 'b@x.test' }, provider.nextHistoryId());
      provider.deleteMessage(a.providerMessageId, provider.nextHistoryId());
      const page = await provider.listMessages(tokens);
      expect(page.messages.map((m) => m.providerMessageId)).not.toContain(a.providerMessageId);
      expect(page.messages).toHaveLength(1);
    });
  });

  describe('threading', () => {
    test('a reply joins the thread of the message it replies to', async () => {
      const original = await provider.send(
        tokens,
        { to: ['lead@x.test'], subject: 'Hello' },
        'k-out',
      );
      const sent = await provider.getMessage(tokens, original.providerMessageId);
      const reply = provider.injectIncoming(
        { from: 'lead@x.test', subject: 'Re: Hello', inReplyTo: original.rfcMessageId },
        provider.nextHistoryId(),
      );
      expect(reply.threadId).toBe(sent.threadId);
    });

    test('an unrelated message starts a new thread', async () => {
      const a = provider.injectIncoming({ from: 'a@x.test' }, provider.nextHistoryId());
      const b = provider.injectIncoming({ from: 'b@x.test' }, provider.nextHistoryId());
      expect(a.threadId).not.toBe(b.threadId);
    });
  });

  describe('send idempotency + counters (CONTRACTS §C6 I-SEND-1)', () => {
    const draft: OutboundEmail = { to: ['lead@x.test'], subject: 'Hi', bodyText: 'body' };

    test('same idempotency key ⇒ same result, one logical send', async () => {
      const first = await provider.send(tokens, draft, 'intent-1');
      const second = await provider.send(tokens, draft, 'intent-1');
      expect(second).toEqual(first);
      expect(provider.deliveredCount).toBe(1);
      // exactly one message actually landed in the mailbox
      const page = await provider.listMessages(tokens);
      expect(page.messages).toHaveLength(1);
    });

    test('counts raw provider calls per key even when deduped', async () => {
      await provider.send(tokens, draft, 'intent-1');
      await provider.send(tokens, draft, 'intent-1');
      await provider.send(tokens, draft, 'intent-2');
      expect(provider.sendCallCountForKey('intent-1')).toBe(2);
      expect(provider.sendCallCountForKey('intent-2')).toBe(1);
      expect(provider.sendCallCount).toBe(3);
      expect(provider.deliveredCount).toBe(2);
    });

    test('different keys are independent logical sends', async () => {
      const a = await provider.send(tokens, draft, 'intent-1');
      const b = await provider.send(tokens, draft, 'intent-2');
      expect(a.providerMessageId).not.toBe(b.providerMessageId);
    });

    test('empty idempotency key is rejected', async () => {
      await expect(provider.send(tokens, draft, '')).rejects.toThrow();
    });

    test('send interceptor fires on entry — can land a reply during the send window', async () => {
      // Simulate a reply arriving exactly when the worker calls send() (I-SEND-2
      // race). The interceptor injects the inbound reply mid-send.
      let replyThreadId: string | undefined;
      provider.setSendInterceptor((key) => {
        if (key === 'racy') {
          const reply = provider.injectIncoming(
            { from: 'lead@x.test', subject: 'stop emailing me' },
            provider.nextHistoryId(),
          );
          replyThreadId = reply.threadId;
        }
      });
      await provider.send(tokens, draft, 'racy');
      expect(replyThreadId).toBeDefined();
      // the reply is visible in history for the sync path to observe
      const page = await provider.listMessages(tokens);
      expect(page.messages.length).toBeGreaterThanOrEqual(2);
    });

    test('send preserves caller headers (List-Unsubscribe survives to the mailbox)', async () => {
      const withHeaders: OutboundEmail = {
        to: ['lead@x.test'],
        subject: 'Seq',
        bodyText: 'hi',
        headers: { 'List-Unsubscribe': '<mailto:u@mock.test>, <https://mock/u>' },
      };
      const res = await provider.send(tokens, withHeaders, 'seq-1');
      const stored = await provider.getMessage(tokens, res.providerMessageId);
      expect(stored.headers['List-Unsubscribe']).toContain('mailto:u@mock.test');
      expect(stored.direction).toBe('out');
    });
  });

  describe('watch()', () => {
    test('returns a future ISO expiry and renews on re-call after the clock moves', async () => {
      const clock = new ManualClock('2026-01-01T00:00:00.000Z');
      const p = new MockEmailProvider({ clock });
      const t = p.mintTokens();
      const first = await p.watch(t, 'https://app/wh/gmail');
      expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(clock.now().getTime());
      expect(p.lastWatchCallback()).toBe('https://app/wh/gmail');

      clock.advance(24 * 60 * 60 * 1000);
      const renewed = await p.watch(t, 'https://app/wh/gmail');
      expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(
        new Date(first.expiresAt).getTime(),
      );
    });

    test('empty callback url is rejected', async () => {
      await expect(provider.watch(tokens, '')).rejects.toThrow();
    });
  });

  describe('determinism', () => {
    test('two providers driven identically produce byte-identical output', async () => {
      async function run(): Promise<unknown> {
        const p = new MockEmailProvider({ clock: new ManualClock() });
        const t = p.mintTokens();
        p.injectIncoming({ from: 'a@x.test', subject: 'one' }, p.nextHistoryId());
        await p.send(t, { to: ['a@x.test'], subject: 're', bodyText: 'x' }, 'k1');
        p.injectIncoming({ from: 'b@x.test', subject: 'two' }, p.nextHistoryId());
        const backfill = await p.listMessages(t);
        const raws = [];
        for (const ref of backfill.messages) {
          raws.push(await p.getMessage(t, ref.providerMessageId));
        }
        return { backfill, raws, tokens: t };
      }
      const one = await run();
      const two = await run();
      expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    });
  });

  describe('token validation', () => {
    test('malformed tokens are rejected by the provider methods', async () => {
      const bad = { accessToken: '', refreshToken: 'r' } as unknown as OAuthTokens;
      await expect(provider.listMessages(bad)).rejects.toThrow();
    });
  });
});
