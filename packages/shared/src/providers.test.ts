import { describe, expect, test } from 'vitest';
import {
  HistoryExpiredError,
  MessageNotFoundError,
  historyPageSchema,
  incomingEmailSchema,
  messagePageSchema,
  oauthTokensSchema,
  outboundEmailSchema,
  rawEmailSchema,
} from './providers.ts';

describe('email provider DTO schemas (CONTRACTS §C2)', () => {
  test('oauthTokens defaults tokenType and requires the secrets', () => {
    const parsed = oauthTokensSchema.parse({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: '2026-07-15T00:00:00.000Z',
      scope: 'gmail.modify',
    });
    expect(parsed.tokenType).toBe('Bearer');
    expect(() => oauthTokensSchema.parse({ accessToken: '', refreshToken: 'r' })).toThrow();
  });

  test('outboundEmail requires at least one recipient and allows custom headers', () => {
    expect(() => outboundEmailSchema.parse({ to: [], subject: 'x' })).toThrow();
    const ok = outboundEmailSchema.parse({
      to: ['a@b.test'],
      subject: 'Hi',
      headers: { 'List-Unsubscribe': '<mailto:u@b.test>' },
    });
    expect(ok.headers?.['List-Unsubscribe']).toContain('mailto');
  });

  test('rawEmail rejects a bad direction and a non-datetime sentAt', () => {
    const base = {
      providerMessageId: 'm1',
      rfcMessageId: '<1@mock>',
      threadId: 't1',
      historyId: '5',
      direction: 'in' as const,
      from: 'a@b.test',
      to: ['rep@mock.test'],
      cc: [],
      subject: 's',
      snippet: 's',
      references: [],
      headers: {},
      labels: ['INBOX'],
      sentAt: '2026-07-15T00:00:00.000Z',
    };
    expect(() => rawEmailSchema.parse(base)).not.toThrow();
    expect(() => rawEmailSchema.parse({ ...base, direction: 'sideways' })).toThrow();
    expect(() => rawEmailSchema.parse({ ...base, sentAt: 'yesterday' })).toThrow();
  });

  test('messagePage and historyPage carry a string cursor', () => {
    const mp = messagePageSchema.parse({ messages: [], historyId: '10' });
    expect(mp.nextPageToken).toBeUndefined();
    const hp = historyPageSchema.parse({
      historyId: '10',
      messagesAdded: [],
      messagesDeleted: [],
      labelsChanged: [],
    });
    expect(hp.historyId).toBe('10');
  });

  test('incomingEmail requires only from', () => {
    expect(() => incomingEmailSchema.parse({})).toThrow();
    expect(incomingEmailSchema.parse({ from: 'x@y.test' }).from).toBe('x@y.test');
  });
});

describe('typed provider errors', () => {
  test('HistoryExpiredError carries the cursor and oldest id', () => {
    const err = new HistoryExpiredError('3', '7');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HistoryExpiredError');
    expect(err.cursor).toBe('3');
    expect(err.oldestHistoryId).toBe('7');
  });

  test('MessageNotFoundError carries the id', () => {
    const err = new MessageNotFoundError('m9');
    expect(err.name).toBe('MessageNotFoundError');
    expect(err.providerMessageId).toBe('m9');
  });
});
