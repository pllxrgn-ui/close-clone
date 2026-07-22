import { randomUUID } from 'node:crypto';
import {
  HistoryExpiredError,
  MessageNotFoundError,
  oauthTokensSchema,
  type EmailProvider,
  type HistoryMessage,
  type HistoryPage,
  type LabelChange,
  type MessagePage,
  type MessageRef,
  type OAuthTokens,
  type OutboundEmail,
  type RawEmail,
  type SendResult,
} from '@switchboard/shared/providers';
import { emailDirectionValues } from '@switchboard/shared';
import { fetchTransport, type GmailHttpResponse, type GmailTransport } from './gmail-transport.ts';

/**
 * Gmail `EmailProvider` (CONTRACTS §C2) — a hand-rolled REST adapter over the
 * Gmail API v1 + Google OAuth. All HTTP goes through an injected `GmailTransport`
 * so the unit suite drives it from recorded/synthetic response fixtures with NO
 * network (task 2b). The adapter is pure translation: it maps Gmail's wire shapes
 * to the frozen C2 DTOs and raises the two typed provider errors
 * (`HistoryExpiredError` on a 404 from `history.list`, `MessageNotFoundError` on a
 * 404/410 from `messages.get`). The provider-agnostic sync engine consumes these
 * exactly as it consumes the mock's.
 *
 * Token refresh is intentionally out of scope here (the C2 interface has no
 * refresh method); a 401 surfaces as a provider error the sync layer maps to
 * REAUTH_REQUIRED. Live client-id/secret wiring is a composition-root concern.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];
const SENT_LABEL = 'SENT';

type Direction = (typeof emailDirectionValues)[number];

export interface GmailProviderConfig {
  clientId: string;
  clientSecret: string;
  /** The mailbox address this adapter serves (From header, thread ownership). */
  address: string;
  scopes?: string[];
  transport?: GmailTransport;
  /** Wall clock (injectable for deterministic token-expiry math in tests). */
  now?: () => Date;
  /** RFC Message-ID factory (injectable for deterministic send tests). */
  messageIdFactory?: () => string;
}

export class GmailApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`gmail api ${status}: ${message}`);
    this.name = 'GmailApiError';
    this.status = status;
  }
}

// --- Gmail wire shapes (only the fields we read) ----------------------------

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

export class GmailEmailProvider implements EmailProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly address: string;
  private readonly scopes: string[];
  private readonly transport: GmailTransport;
  private readonly now: () => Date;
  private readonly messageIdFactory: () => string;

  constructor(config: GmailProviderConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.address = config.address;
    this.scopes = config.scopes ?? DEFAULT_SCOPES;
    this.transport = config.transport ?? fetchTransport;
    this.now = config.now ?? (() => new Date());
    this.messageIdFactory =
      config.messageIdFactory ??
      (() => `<${randomUUID()}@${this.address.split('@')[1] ?? 'mail'}>`);
  }

  // --- OAuth ----------------------------------------------------------------

  async getAuthUrl(accountHint: string, redirectUri: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      login_hint: accountHint,
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
    if (code.length === 0) throw new Error('gmail exchangeCode: empty code');
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString();
    const res = await this.transport({
      method: 'POST',
      url: TOKEN_ENDPOINT,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = this.parseOk(res) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    if (json.access_token === undefined || json.refresh_token === undefined) {
      throw new GmailApiError(res.status, 'token response missing access/refresh token');
    }
    const expiresAt = new Date(
      this.now().getTime() + (json.expires_in ?? 3600) * 1000,
    ).toISOString();
    return oauthTokensSchema.parse({
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt,
      scope: json.scope ?? this.scopes.join(' '),
      tokenType: json.token_type ?? 'Bearer',
    });
  }

  async getMailboxAddress(tokens: OAuthTokens): Promise<string> {
    const profile = await this.profile(tokens);
    if (profile.emailAddress === undefined) {
      throw new GmailApiError(profile.status, 'profile missing emailAddress');
    }
    return profile.emailAddress;
  }

  // --- Backfill -------------------------------------------------------------

  async listMessages(tokens: OAuthTokens, pageToken?: string): Promise<MessagePage> {
    oauthTokensSchema.parse(tokens);
    const params = new URLSearchParams({ maxResults: '100' });
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    const res = await this.get(tokens, `${API_BASE}/messages?${params.toString()}`);
    const json = this.parseOk(res) as {
      messages?: { id: string; threadId: string }[];
      nextPageToken?: string;
    };
    const messages: MessageRef[] = (json.messages ?? []).map((m) => ({
      providerMessageId: m.id,
      threadId: m.threadId,
    }));
    const historyId = await this.currentHistoryId(tokens);
    const page: MessagePage = {
      messages,
      historyId,
      ...(json.nextPageToken !== undefined ? { nextPageToken: json.nextPageToken } : {}),
    };
    return page;
  }

  // --- Incremental ----------------------------------------------------------

  async listHistory(tokens: OAuthTokens, cursor: string): Promise<HistoryPage> {
    oauthTokensSchema.parse(tokens);
    const params = new URLSearchParams({ startHistoryId: cursor, maxResults: '500' });
    const res = await this.transport({
      method: 'GET',
      url: `${API_BASE}/history?${params.toString()}`,
      headers: this.authHeaders(tokens),
    });
    if (res.status === 404) {
      throw new HistoryExpiredError(cursor, cursor);
    }
    const json = this.parseOk(res) as {
      historyId?: string;
      nextPageToken?: string;
      history?: GmailHistoryRecord[];
    };
    return coalesceHistory(json.history ?? [], json.historyId ?? cursor, json.nextPageToken);
  }

  // --- Fetch ----------------------------------------------------------------

  async getMessage(tokens: OAuthTokens, providerMessageId: string): Promise<RawEmail> {
    oauthTokensSchema.parse(tokens);
    const res = await this.transport({
      method: 'GET',
      url: `${API_BASE}/messages/${encodeURIComponent(providerMessageId)}?format=full`,
      headers: this.authHeaders(tokens),
    });
    if (res.status === 404 || res.status === 410) {
      throw new MessageNotFoundError(providerMessageId);
    }
    const msg = this.parseOk(res) as GmailMessage;
    return this.toRawEmail(msg);
  }

  // --- Send -----------------------------------------------------------------

  async send(
    tokens: OAuthTokens,
    draft: OutboundEmail,
    idempotencyKey: string,
  ): Promise<SendResult> {
    oauthTokensSchema.parse(tokens);
    if (idempotencyKey.length === 0) throw new Error('gmail send: empty idempotency key');
    const rfcMessageId = draft.headers?.['Message-ID'] ?? this.messageIdFactory();
    const raw = buildMime(this.address, draft, rfcMessageId);
    const res = await this.transport({
      method: 'POST',
      url: `${API_BASE}/messages/send`,
      headers: { ...this.authHeaders(tokens), 'content-type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    const json = this.parseOk(res) as { id?: string };
    if (json.id === undefined) throw new GmailApiError(res.status, 'send response missing id');
    return { providerMessageId: json.id, rfcMessageId };
  }

  // --- Watch ----------------------------------------------------------------

  async watch(tokens: OAuthTokens, callbackUrl: string): Promise<{ expiresAt: string }> {
    oauthTokensSchema.parse(tokens);
    if (callbackUrl.length === 0) throw new Error('gmail watch: empty topic');
    const res = await this.transport({
      method: 'POST',
      url: `${API_BASE}/watch`,
      headers: { ...this.authHeaders(tokens), 'content-type': 'application/json' },
      // For Gmail, `callbackUrl` carries the Pub/Sub topic name.
      body: JSON.stringify({ topicName: callbackUrl, labelIds: ['INBOX'] }),
    });
    const json = this.parseOk(res) as { historyId?: string; expiration?: string };
    const expiration = json.expiration ?? String(this.now().getTime() + 7 * 24 * 3600 * 1000);
    return { expiresAt: new Date(Number(expiration)).toISOString() };
  }

  // --- internals ------------------------------------------------------------

  private authHeaders(tokens: OAuthTokens): Record<string, string> {
    return { authorization: `Bearer ${tokens.accessToken}` };
  }

  private get(tokens: OAuthTokens, url: string): Promise<GmailHttpResponse> {
    return this.transport({ method: 'GET', url, headers: this.authHeaders(tokens) });
  }

  private async currentHistoryId(tokens: OAuthTokens): Promise<string> {
    const profile = await this.profile(tokens);
    if (profile.historyId === undefined) {
      throw new GmailApiError(profile.status, 'profile missing historyId');
    }
    return profile.historyId;
  }

  private async profile(tokens: OAuthTokens): Promise<{
    emailAddress?: string;
    historyId?: string;
    status: number;
  }> {
    const response = await this.get(tokens, `${API_BASE}/profile`);
    const profile = this.parseOk(response) as { emailAddress?: string; historyId?: string };
    return { ...profile, status: response.status };
  }

  private parseOk(res: GmailHttpResponse): unknown {
    if (res.status < 200 || res.status >= 300) {
      throw new GmailApiError(res.status, res.bodyText.slice(0, 200));
    }
    try {
      return JSON.parse(res.bodyText);
    } catch {
      throw new GmailApiError(res.status, 'response body is not JSON');
    }
  }

  private toRawEmail(msg: GmailMessage): RawEmail {
    const headers = flattenHeaders(msg.payload);
    const direction: Direction = (msg.labelIds ?? []).includes(SENT_LABEL) ? 'out' : 'in';
    const rfcMessageId = headers['message-id'] ?? `<${msg.id}@gmail>`;
    const body = extractBodies(msg.payload);
    const sentAt =
      msg.internalDate !== undefined
        ? new Date(Number(msg.internalDate)).toISOString()
        : this.now().toISOString();

    const raw: RawEmail = {
      providerMessageId: msg.id,
      rfcMessageId,
      threadId: msg.threadId,
      historyId: msg.historyId ?? '0',
      direction,
      from: headers['from'] ?? '',
      to: splitAddresses(headers['to']),
      cc: splitAddresses(headers['cc']),
      subject: headers['subject'] ?? '',
      snippet: msg.snippet ?? '',
      references: splitRefs(headers['references']),
      headers,
      labels: msg.labelIds ?? [],
      sentAt,
      ...(body.text !== undefined ? { bodyText: body.text } : {}),
      ...(body.html !== undefined ? { bodyHtml: body.html } : {}),
      ...(headers['in-reply-to'] !== undefined ? { inReplyTo: headers['in-reply-to'] } : {}),
    };
    return raw;
  }
}

// --- History coalescing (module-private helpers, unit-tested via the adapter) -

interface GmailHistoryRecord {
  id?: string;
  messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[];
  messagesDeleted?: { message: { id: string; threadId: string } }[];
  labelsAdded?: {
    message: { id: string; threadId: string; labelIds?: string[] };
    labelIds: string[];
  }[];
  labelsRemoved?: {
    message: { id: string; threadId: string; labelIds?: string[] };
    labelIds: string[];
  }[];
}

/**
 * Coalesce Gmail history records into net per-message effects, matching the C2
 * `HistoryPage` contract (add-then-delete nets to nothing; label churn collapses
 * to the final label set). Order of first appearance is preserved.
 */
export function coalesceHistory(
  records: GmailHistoryRecord[],
  historyId: string,
  nextPageToken: string | undefined,
): HistoryPage {
  const order: string[] = [];
  type State = {
    threadId: string;
    /** The message existed before this page (first op was not an add). */
    existed: boolean;
    /** The message was added within this page. */
    added: boolean;
    /** Net presence after all ops in the page. */
    present: boolean;
    labelTouched: boolean;
    /** Final label set; initialised on first sighting, then delta-applied. */
    labels: string[];
    labelsInit: boolean;
  };
  const states = new Map<string, State>();

  // First sighting fixes `existed`/`present` from whether the op is an add.
  const ensure = (id: string, threadId: string, isAdd: boolean): State => {
    let s = states.get(id);
    if (s === undefined) {
      order.push(id);
      s = {
        threadId,
        existed: !isAdd,
        added: false,
        present: !isAdd, // a pre-existing message is present until deleted
        labelTouched: false,
        labels: [],
        labelsInit: false,
      };
      states.set(id, s);
    }
    return s;
  };
  const initLabels = (s: State, from: string[] | undefined): void => {
    if (!s.labelsInit) {
      s.labels = [...(from ?? [])];
      s.labelsInit = true;
    }
  };

  for (const rec of records) {
    for (const a of rec.messagesAdded ?? []) {
      const s = ensure(a.message.id, a.message.threadId, true);
      s.added = true;
      s.present = true;
      s.labels = [...(a.message.labelIds ?? [])];
      s.labelsInit = true;
    }
    for (const d of rec.messagesDeleted ?? []) {
      const s = ensure(d.message.id, d.message.threadId, false);
      s.present = false;
    }
    for (const l of rec.labelsAdded ?? []) {
      const s = ensure(l.message.id, l.message.threadId, false);
      initLabels(s, l.message.labelIds);
      s.labels = [...new Set([...s.labels, ...l.labelIds])];
      s.labelTouched = true;
    }
    for (const l of rec.labelsRemoved ?? []) {
      const s = ensure(l.message.id, l.message.threadId, false);
      initLabels(s, l.message.labelIds);
      const removed = new Set(l.labelIds);
      s.labels = s.labels.filter((x) => !removed.has(x));
      s.labelTouched = true;
    }
  }

  const messagesAdded: HistoryMessage[] = [];
  const messagesDeleted: MessageRef[] = [];
  const labelsChanged: LabelChange[] = [];
  for (const id of order) {
    const s = states.get(id)!;
    if (s.added) {
      // New message: surfaces once (final labels) iff still present; an
      // add-then-delete within the page coalesces away.
      if (s.present)
        messagesAdded.push({ providerMessageId: id, threadId: s.threadId, labels: s.labels });
      continue;
    }
    if (s.existed && !s.present) {
      messagesDeleted.push({ providerMessageId: id, threadId: s.threadId });
    } else if (s.existed && s.labelTouched) {
      labelsChanged.push({ providerMessageId: id, threadId: s.threadId, labels: s.labels });
    }
  }

  return {
    historyId,
    messagesAdded,
    messagesDeleted,
    labelsChanged,
    ...(nextPageToken !== undefined ? { nextPageToken } : {}),
  };
}

/** Flatten a Gmail payload's header list (recursively) into a lowercased map. */
export function flattenHeaders(payload: GmailPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (part: GmailPart | undefined): void => {
    if (part === undefined) return;
    for (const h of part.headers ?? []) {
      const key = h.name.toLowerCase();
      if (!(key in out)) out[key] = h.value;
    }
  };
  walk(payload);
  return out;
}

/** Extract text/plain + text/html bodies from a (possibly multipart) payload. */
export function extractBodies(payload: GmailPart | undefined): {
  text: string | undefined;
  html: string | undefined;
} {
  let text: string | undefined;
  let html: string | undefined;
  const walk = (part: GmailPart | undefined): void => {
    if (part === undefined) return;
    const data = part.body?.data;
    if (data !== undefined && part.mimeType === 'text/plain' && text === undefined) {
      text = decodeB64Url(data);
    } else if (data !== undefined && part.mimeType === 'text/html' && html === undefined) {
      html = decodeB64Url(data);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return { text, html };
}

function decodeB64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function splitAddresses(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function splitRefs(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build a base64url-encoded RFC-5322 message for `messages.send`. */
export function buildMime(from: string, draft: OutboundEmail, rfcMessageId: string): string {
  const lines: string[] = [];
  lines.push(`Message-ID: ${rfcMessageId}`);
  lines.push(`From: ${from}`);
  lines.push(`To: ${draft.to.join(', ')}`);
  if (draft.cc !== undefined && draft.cc.length > 0) lines.push(`Cc: ${draft.cc.join(', ')}`);
  lines.push(`Subject: ${draft.subject}`);
  if (draft.inReplyTo !== undefined) lines.push(`In-Reply-To: ${draft.inReplyTo}`);
  if (draft.references !== undefined && draft.references.length > 0) {
    lines.push(`References: ${draft.references.join(' ')}`);
  }
  for (const [name, value] of Object.entries(draft.headers ?? {})) {
    if (name.toLowerCase() === 'message-id') continue; // already emitted
    lines.push(`${name}: ${value}`);
  }
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('');
  lines.push(draft.bodyText ?? draft.bodyHtml ?? '');
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}
