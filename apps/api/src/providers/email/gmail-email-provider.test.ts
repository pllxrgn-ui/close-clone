import { describe, expect, test } from 'vitest';
import {
  HistoryExpiredError,
  MessageNotFoundError,
  type OAuthTokens,
} from '@switchboard/shared/providers';
import {
  GmailApiError,
  GmailEmailProvider,
  buildMime,
  coalesceHistory,
} from './gmail-email-provider.ts';
import type { GmailHttpRequest, GmailHttpResponse, GmailTransport } from './gmail-transport.ts';

/**
 * Gmail REST adapter (CONTRACTS §C2). Driven entirely by an injected transport
 * over synthetic Gmail wire responses — NO network. Covers OAuth exchange, the
 * backfill/incremental/fetch translations, the two typed provider errors, and the
 * send MIME build. History coalescing is unit-tested directly.
 */

const TOKENS: OAuthTokens = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: '2026-01-01T01:00:00.000Z',
  scope: 'gmail.modify',
  tokenType: 'Bearer',
};

interface Route {
  match: (req: GmailHttpRequest) => boolean;
  status?: number;
  body: unknown;
}

function transportOf(routes: Route[]): { transport: GmailTransport; calls: GmailHttpRequest[] } {
  const calls: GmailHttpRequest[] = [];
  const transport: GmailTransport = async (req) => {
    calls.push(req);
    const route = routes.find((r) => r.match(req));
    if (route === undefined) throw new Error(`no fixture for ${req.method} ${req.url}`);
    const res: GmailHttpResponse = {
      status: route.status ?? 200,
      bodyText: typeof route.body === 'string' ? route.body : JSON.stringify(route.body),
    };
    return res;
  };
  return { transport, calls };
}

function provider(routes: Route[], extra?: Partial<Parameters<typeof buildProvider>[0]>) {
  return buildProvider({ transport: transportOf(routes).transport, ...extra });
}

function buildProvider(cfg: {
  transport: GmailTransport;
  messageIdFactory?: () => string;
  now?: () => Date;
}): GmailEmailProvider {
  return new GmailEmailProvider({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    address: 'rep@company.test',
    transport: cfg.transport,
    ...(cfg.messageIdFactory ? { messageIdFactory: cfg.messageIdFactory } : {}),
    ...(cfg.now ? { now: cfg.now } : {}),
  });
}

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

describe('getAuthUrl', () => {
  test('builds a Google consent URL with offline access + login hint', async () => {
    const p = provider([]);
    const url = await p.getAuthUrl('rep@company.test', 'https://app/cb');
    expect(url).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('login_hint=rep%40company.test');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp%2Fcb');
  });
});

describe('exchangeCode', () => {
  test('maps the token response to OAuthTokens with a computed expiry', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const p = provider(
      [
        {
          match: (r) => r.url.includes('oauth2.googleapis.com/token'),
          body: {
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 3600,
            scope: 'gmail.modify',
            token_type: 'Bearer',
          },
        },
      ],
      { now: () => now },
    );
    const tokens = await p.exchangeCode('the-code', 'https://app/cb');
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.expiresAt).toBe('2026-01-01T01:00:00.000Z');
  });

  test('throws when the token response omits the refresh token', async () => {
    const p = provider([{ match: (r) => r.url.includes('/token'), body: { access_token: 'at' } }]);
    await expect(p.exchangeCode('c', 'https://app/cb')).rejects.toThrow(GmailApiError);
  });
});

describe('listMessages (backfill)', () => {
  test('maps refs, snapshots profile historyId, and carries the page token', async () => {
    const p = provider([
      {
        match: (r) => r.url.includes('/messages?'),
        body: {
          messages: [
            { id: 'm1', threadId: 't1' },
            { id: 'm2', threadId: 't1' },
          ],
          nextPageToken: 'PAGE2',
        },
      },
      {
        match: (r) => r.url.includes('/profile'),
        body: { emailAddress: 'rep@company.test', historyId: '9000' },
      },
    ]);
    const page = await p.listMessages(TOKENS);
    expect(page.messages).toEqual([
      { providerMessageId: 'm1', threadId: 't1' },
      { providerMessageId: 'm2', threadId: 't1' },
    ]);
    expect(page.historyId).toBe('9000');
    expect(page.nextPageToken).toBe('PAGE2');
  });
});

describe('getMessage (fetch)', () => {
  test('parses headers, decodes the text body, and infers direction from labels', async () => {
    const p = provider([
      {
        match: (r) => r.url.includes('/messages/m1'),
        body: {
          id: 'm1',
          threadId: 't1',
          historyId: '9100',
          internalDate: '1767225600000', // 2026-01-01T00:00:00Z
          snippet: 'Hello there',
          labelIds: ['INBOX', 'UNREAD'],
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'Message-ID', value: '<abc@ext>' },
              { name: 'From', value: 'sender@ext.test' },
              { name: 'To', value: 'rep@company.test, other@company.test' },
              { name: 'Cc', value: 'cc@company.test' },
              { name: 'Subject', value: 'Re: Demo' },
              { name: 'In-Reply-To', value: '<parent@ext>' },
              { name: 'References', value: '<root@ext> <parent@ext>' },
            ],
            body: { data: b64url('Hello there, body text.') },
          },
        },
      },
    ]);
    const raw = await p.getMessage(TOKENS, 'm1');
    expect(raw.providerMessageId).toBe('m1');
    expect(raw.rfcMessageId).toBe('<abc@ext>');
    expect(raw.direction).toBe('in');
    expect(raw.from).toBe('sender@ext.test');
    expect(raw.to).toEqual(['rep@company.test', 'other@company.test']);
    expect(raw.cc).toEqual(['cc@company.test']);
    expect(raw.subject).toBe('Re: Demo');
    expect(raw.inReplyTo).toBe('<parent@ext>');
    expect(raw.references).toEqual(['<root@ext>', '<parent@ext>']);
    expect(raw.bodyText).toBe('Hello there, body text.');
    expect(raw.sentAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('a SENT label yields an outbound direction', async () => {
    const p = provider([
      {
        match: (r) => r.url.includes('/messages/m2'),
        body: {
          id: 'm2',
          threadId: 't2',
          labelIds: ['SENT'],
          payload: { headers: [{ name: 'From', value: 'rep@company.test' }] },
        },
      },
    ]);
    const raw = await p.getMessage(TOKENS, 'm2');
    expect(raw.direction).toBe('out');
  });

  test('a 404 becomes MessageNotFoundError', async () => {
    const p = provider([
      { match: (r) => r.url.includes('/messages/gone'), status: 404, body: { error: 'not found' } },
    ]);
    await expect(p.getMessage(TOKENS, 'gone')).rejects.toBeInstanceOf(MessageNotFoundError);
  });
});

describe('listHistory (incremental)', () => {
  test('coalesces adds/label changes and carries the next page token', async () => {
    const p = provider([
      {
        match: (r) => r.url.includes('/history?'),
        body: {
          historyId: '9500',
          nextPageToken: 'H2',
          history: [
            { messagesAdded: [{ message: { id: 'm10', threadId: 't10', labelIds: ['INBOX'] } }] },
            { labelsAdded: [{ message: { id: 'm10', threadId: 't10' }, labelIds: ['STARRED'] }] },
          ],
        },
      },
    ]);
    const page = await p.listHistory(TOKENS, '9000');
    expect(page.historyId).toBe('9500');
    expect(page.nextPageToken).toBe('H2');
    // Add (INBOX) + subsequent STARRED add on the same new message ⇒ one add with
    // the merged final labels, and no separate label-change entry.
    expect(page.messagesAdded).toEqual([
      { providerMessageId: 'm10', threadId: 't10', labels: ['INBOX', 'STARRED'] },
    ]);
    expect(page.labelsChanged).toHaveLength(0);
  });

  test('a 404 becomes HistoryExpiredError', async () => {
    const p = provider([
      { match: (r) => r.url.includes('/history?'), status: 404, body: { error: 'not found' } },
    ]);
    await expect(p.listHistory(TOKENS, '1')).rejects.toBeInstanceOf(HistoryExpiredError);
  });
});

describe('send', () => {
  test('posts a base64url MIME message and returns the ids', async () => {
    const { transport, calls } = transportOf([
      {
        match: (r) => r.url.includes('/messages/send'),
        body: { id: 'sent-1', threadId: 't-sent' },
      },
    ]);
    const p = buildProvider({ transport, messageIdFactory: () => '<fixed@company.test>' });
    const result = await p.send(
      TOKENS,
      { to: ['dst@ext.test'], subject: 'Hi', bodyText: 'Body' },
      'intent-1',
    );
    expect(result).toEqual({ providerMessageId: 'sent-1', rfcMessageId: '<fixed@company.test>' });

    const sendCall = calls.find((c) => c.url.includes('/send'))!;
    const raw = JSON.parse(sendCall.body!).raw as string;
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('Message-ID: <fixed@company.test>');
    expect(decoded).toContain('From: rep@company.test');
    expect(decoded).toContain('To: dst@ext.test');
    expect(decoded).toContain('Subject: Hi');
  });
});

describe('watch', () => {
  test('returns the subscription expiry as ISO-8601', async () => {
    const p = provider([
      {
        match: (r) => r.url.includes('/watch'),
        body: { historyId: '9000', expiration: '1767225600000' },
      },
    ]);
    const res = await p.watch(TOKENS, 'projects/x/topics/gmail');
    expect(res.expiresAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('coalesceHistory (unit)', () => {
  test('add-then-delete within a page nets to nothing', () => {
    const page = coalesceHistory(
      [
        { messagesAdded: [{ message: { id: 'x', threadId: 't' } }] },
        { messagesDeleted: [{ message: { id: 'x', threadId: 't' } }] },
      ],
      '100',
      undefined,
    );
    expect(page.messagesAdded).toHaveLength(0);
    expect(page.messagesDeleted).toHaveLength(0);
  });

  test('label add then remove collapses to the final label set', () => {
    const page = coalesceHistory(
      [
        {
          labelsAdded: [
            { message: { id: 'y', threadId: 't', labelIds: ['INBOX'] }, labelIds: ['STARRED'] },
          ],
        },
        {
          labelsRemoved: [
            {
              message: { id: 'y', threadId: 't', labelIds: ['INBOX', 'STARRED'] },
              labelIds: ['STARRED'],
            },
          ],
        },
      ],
      '100',
      undefined,
    );
    expect(page.labelsChanged).toEqual([
      { providerMessageId: 'y', threadId: 't', labels: ['INBOX'] },
    ]);
  });
});

describe('buildMime (unit)', () => {
  test('emits RFC-5322 headers including In-Reply-To/References when present', () => {
    const mime = buildMime(
      'rep@company.test',
      {
        to: ['a@ext.test', 'b@ext.test'],
        cc: ['c@ext.test'],
        subject: 'Reply',
        bodyText: 'hi',
        inReplyTo: '<parent@ext>',
        references: ['<root@ext>', '<parent@ext>'],
      },
      '<new@company.test>',
    );
    const decoded = Buffer.from(mime, 'base64url').toString('utf8');
    expect(decoded).toContain('To: a@ext.test, b@ext.test');
    expect(decoded).toContain('Cc: c@ext.test');
    expect(decoded).toContain('In-Reply-To: <parent@ext>');
    expect(decoded).toContain('References: <root@ext> <parent@ext>');
  });
});
