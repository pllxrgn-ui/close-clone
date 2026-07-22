import {
  HistoryExpiredError,
  MessageNotFoundError,
  incomingEmailSchema,
  oauthTokensSchema,
  outboundEmailSchema,
  type EmailProvider,
  type HistoryMessage,
  type HistoryPage,
  type IncomingEmail,
  type LabelChange,
  type MessagePage,
  type MessageRef,
  type OAuthTokens,
  type OutboundEmail,
  type RawEmail,
  type SendResult,
} from '@switchboard/shared/providers';
import { ManualClock, SequentialIds, type Clock, type IdSource } from './clock.ts';

/**
 * In-memory `EmailProvider` (CONTRACTS §C2) with real Gmail history semantics,
 * for MOCK_MODE and the sync/send property suites (§C5 I-SYNC, §C6 I-SEND).
 *
 * One instance == one mailbox. Token identity is *validated* on every call but
 * not used to select a mailbox — construct one provider per simulated mailbox.
 *
 * Guarantees (task 2a acceptance):
 *  - Monotonic history ids. Each mutation (incoming inject, outbound send, label
 *    change) allocates a strictly-greater id.
 *  - `listHistory` COALESCES multiple changes to the same message within a page.
 *  - Injectable `HistoryExpiredError` via `expireHistoryBefore` → RESYNC path.
 *  - `listMessages` paginates the full mailbox for backfill.
 *  - `send()` is idempotent on `idempotencyKey` (same key ⇒ same result, one
 *    logical message) and counts raw provider calls (I-SEND-1 inspection).
 *  - Deterministic: no `Date.now()`/`Math.random()` — clock + ids are injected.
 */

const DEFAULT_HISTORY_PAGE_SIZE = 100;
const DEFAULT_BACKFILL_PAGE_SIZE = 100;
const DEFAULT_WATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // Gmail watch ≈ 7 days
const INBOX_LABEL = 'INBOX';
const SENT_LABEL = 'SENT';
const DEMO_AUTH_CODE_PREFIX = 'mock-mailbox.';
const MOCK_ACCESS_TOKEN_PREFIX = 'mock-access-';

type HistoryOp = 'add' | 'delete' | 'label';

interface HistoryRecord {
  historyId: number;
  providerMessageId: string;
  op: HistoryOp;
  /** Label set after the op (for `add`/`label`); empty for `delete`. */
  labels: string[];
}

interface StoredMessage {
  providerMessageId: string;
  rfcMessageId: string;
  threadId: string;
  addHistoryId: number;
  direction: 'in' | 'out';
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;
  bodyText: string | undefined;
  bodyHtml: string | undefined;
  inReplyTo: string | undefined;
  references: string[];
  headers: Record<string, string>;
  labels: string[];
  sentAt: string;
  deleted: boolean;
}

export interface MockEmailProviderOptions {
  /** Mailbox address the provider serves. */
  address?: string;
  /** Authorization endpoint override for an in-process demo OAuth callback. */
  authorizationUrl?: string;
  clock?: Clock;
  ids?: IdSource;
  /** Max history records returned per `listHistory` page (forces multi-page). */
  historyPageSize?: number;
  /** Max messages returned per `listMessages` backfill page. */
  backfillPageSize?: number;
  /** Watch subscription lifetime in ms. */
  watchTtlMs?: number;
  /** Starting history id (mailbox baseline before any mutation). */
  startHistoryId?: number;
}

/** Injected exactly when `send()` is entered — lets a test land a reply mid-send
 *  (2e/2f pause-race scripting). Receives the idempotency key and the draft. May
 *  return a promise, which `send()` awaits BEFORE it produces its result — so a
 *  test can commit a competing pause/suppression/unsubscribe transaction that is
 *  guaranteed to land inside the provider network window (the gap between the
 *  claim commit and the SENT commit), the precise seam I-SEND-2 defends. Throwing
 *  (or rejecting) simulates a dead mailbox / provider rejection. */
export type SendInterceptor = (
  idempotencyKey: string,
  draft: OutboundEmail,
) => void | Promise<void>;

export class MockEmailProvider implements EmailProvider {
  readonly address: string;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly historyPageSize: number;
  private readonly backfillPageSize: number;
  private readonly watchTtlMs: number;
  private readonly authorizationUrl: string;
  private readonly usesLocalAuthorizationCallback: boolean;

  /** Insertion-ordered message store (order = backfill order). */
  private readonly messages = new Map<string, StoredMessage>();
  /** By RFC Message-ID, for reply threading. */
  private readonly byRfcId = new Map<string, StoredMessage>();
  private readonly history: HistoryRecord[] = [];

  private currentHistoryId: number;
  private oldestHistoryId: number;

  /** Idempotent-send ledger: key → the one result ever returned for it. */
  private readonly sendLedger = new Map<string, SendResult>();
  private totalSendCalls = 0;
  private readonly sendCallsByKey = new Map<string, number>();
  private sendInterceptor: SendInterceptor | undefined;

  private lastWatchCallbackUrl: string | undefined;

  constructor(options: MockEmailProviderOptions = {}) {
    this.address = options.address ?? 'rep@mock.test';
    this.clock = options.clock ?? new ManualClock();
    this.ids = options.ids ?? new SequentialIds();
    this.historyPageSize = options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
    this.backfillPageSize = options.backfillPageSize ?? DEFAULT_BACKFILL_PAGE_SIZE;
    this.watchTtlMs = options.watchTtlMs ?? DEFAULT_WATCH_TTL_MS;
    this.authorizationUrl = options.authorizationUrl ?? 'https://mock.local/oauth/authorize';
    this.usesLocalAuthorizationCallback = options.authorizationUrl !== undefined;
    const start = options.startHistoryId ?? 1;
    this.currentHistoryId = start;
    this.oldestHistoryId = start;
  }

  // --- EmailProvider (CONTRACTS §C2) ---------------------------------------

  async getAuthUrl(accountHint: string, redirectUri: string): Promise<string> {
    const url = new URL(this.authorizationUrl);
    url.searchParams.set('login_hint', accountHint);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('provider', 'mock');
    if (this.usesLocalAuthorizationCallback) {
      url.searchParams.set(
        'code',
        `${DEMO_AUTH_CODE_PREFIX}${Buffer.from(accountHint, 'utf8').toString('base64url')}`,
      );
    }
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
    if (code.length === 0) throw new Error('mock exchangeCode: empty authorization code');
    if (redirectUri.length === 0) throw new Error('mock exchangeCode: empty redirect uri');
    const address = code.startsWith(DEMO_AUTH_CODE_PREFIX)
      ? Buffer.from(code.slice(DEMO_AUTH_CODE_PREFIX.length), 'base64url').toString('utf8')
      : this.address;
    return this.mintTokensFor(address);
  }

  async getMailboxAddress(tokens: OAuthTokens): Promise<string> {
    oauthTokensSchema.parse(tokens);
    return tokens.accessToken.startsWith(MOCK_ACCESS_TOKEN_PREFIX)
      ? tokens.accessToken.slice(MOCK_ACCESS_TOKEN_PREFIX.length)
      : this.address;
  }

  async listHistory(tokens: OAuthTokens, cursor: string): Promise<HistoryPage> {
    oauthTokensSchema.parse(tokens);
    const from = this.parseCursor(cursor);
    if (from < this.oldestHistoryId) {
      throw new HistoryExpiredError(cursor, String(this.oldestHistoryId));
    }
    // Records strictly after the cursor, in id order, capped to one page.
    const after = this.history.filter((r) => r.historyId > from);
    after.sort((a, b) => a.historyId - b.historyId);
    const page = after.slice(0, this.historyPageSize);
    const hasMore = after.length > page.length;

    // `upTo` is the cursor the caller advances to; when caught up (no more
    // records at all) it stays at the current mailbox head so a follow-up
    // listHistory returns an empty page rather than re-expiring.
    const upTo = page.length > 0 ? page[page.length - 1]!.historyId : this.currentHistoryId;

    const result = this.coalescePage(page, from);
    const historyPage: HistoryPage = {
      historyId: String(upTo),
      messagesAdded: result.added,
      messagesDeleted: result.deleted,
      labelsChanged: result.labelsChanged,
      // pagination is by advancing the cursor to `historyId`; the token mirrors
      // it so a caller that echoes nextPageToken as the next cursor still works.
      ...(hasMore ? { nextPageToken: String(upTo) } : {}),
    };
    return historyPage;
  }

  async listMessages(tokens: OAuthTokens, pageToken?: string): Promise<MessagePage> {
    oauthTokensSchema.parse(tokens);
    const offset = pageToken === undefined ? 0 : this.decodeOffsetToken(pageToken);
    const live = [...this.messages.values()].filter((m) => !m.deleted);
    const slice = live.slice(offset, offset + this.backfillPageSize);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < live.length;
    const refs: MessageRef[] = slice.map((m) => ({
      providerMessageId: m.providerMessageId,
      threadId: m.threadId,
    }));
    const page: MessagePage = {
      messages: refs,
      historyId: String(this.currentHistoryId),
      ...(hasMore ? { nextPageToken: this.encodeOffsetToken(nextOffset) } : {}),
    };
    return page;
  }

  async getMessage(tokens: OAuthTokens, providerMessageId: string): Promise<RawEmail> {
    oauthTokensSchema.parse(tokens);
    const stored = this.messages.get(providerMessageId);
    if (stored === undefined || stored.deleted) {
      throw new MessageNotFoundError(providerMessageId);
    }
    return this.toRawEmail(stored);
  }

  async send(
    tokens: OAuthTokens,
    draft: OutboundEmail,
    idempotencyKey: string,
  ): Promise<SendResult> {
    oauthTokensSchema.parse(tokens);
    const parsedDraft = outboundEmailSchema.parse(draft);
    if (idempotencyKey.length === 0) throw new Error('mock send: empty idempotency key');

    // Count every raw call (I-SEND-1: property test asserts ≤1 call per key).
    this.totalSendCalls += 1;
    this.sendCallsByKey.set(idempotencyKey, (this.sendCallsByKey.get(idempotencyKey) ?? 0) + 1);

    // Scripting hook fires on every entry, before the idempotency short-circuit,
    // so a reply can be scripted to land during the send/claim window. Awaited so
    // an async competing transaction (pause/suppress/unsubscribe) is guaranteed to
    // commit before this send resolves (2f I-SEND-2 during-send seam).
    await this.sendInterceptor?.(idempotencyKey, parsedDraft);

    const prior = this.sendLedger.get(idempotencyKey);
    if (prior !== undefined) {
      return prior; // idempotent: one logical send, same result
    }

    const providerMessageId = this.ids.next('msg');
    const rfcMessageId = parsedDraft.headers?.['Message-ID'] ?? this.newRfcId();
    const threadId = this.resolveThreadId(parsedDraft.inReplyTo, parsedDraft.references);
    const historyId = this.allocateHistoryId();

    const stored: StoredMessage = {
      providerMessageId,
      rfcMessageId,
      threadId,
      addHistoryId: historyId,
      direction: 'out',
      from: this.address,
      to: parsedDraft.to,
      cc: parsedDraft.cc ?? [],
      subject: parsedDraft.subject,
      snippet: this.deriveSnippet(parsedDraft.bodyText, parsedDraft.subject),
      bodyText: parsedDraft.bodyText,
      bodyHtml: parsedDraft.bodyHtml,
      inReplyTo: parsedDraft.inReplyTo,
      references: parsedDraft.references ?? [],
      headers: parsedDraft.headers ?? {},
      labels: [SENT_LABEL],
      sentAt: this.nowIso(),
      deleted: false,
    };
    this.commitMessage(stored);

    const result: SendResult = { providerMessageId, rfcMessageId };
    this.sendLedger.set(idempotencyKey, result);
    return result;
  }

  async watch(tokens: OAuthTokens, callbackUrl: string): Promise<{ expiresAt: string }> {
    oauthTokensSchema.parse(tokens);
    if (callbackUrl.length === 0) throw new Error('mock watch: empty callback url');
    this.lastWatchCallbackUrl = callbackUrl;
    const expiresAt = new Date(this.clock.now().getTime() + this.watchTtlMs).toISOString();
    return { expiresAt };
  }

  // --- Scripting hooks (CONTRACTS §C2 mock hooks) --------------------------

  /**
   * Inject an inbound message at an explicit history id (Gmail push arrival).
   * `atHistoryId` must be strictly greater than the current head to preserve
   * monotonicity; pass `nextHistoryId()` for the next contiguous id. Replies
   * (`inReplyTo`/`references` matching a stored message) join that thread.
   */
  injectIncoming(email: IncomingEmail, atHistoryId: number): RawEmail {
    const parsed = incomingEmailSchema.parse(email);
    const historyId = this.allocateHistoryId(atHistoryId);
    const providerMessageId = this.ids.next('msg');
    const rfcMessageId = parsed.rfcMessageId ?? this.newRfcId();
    const threadId = parsed.threadId ?? this.resolveThreadId(parsed.inReplyTo, parsed.references);

    const stored: StoredMessage = {
      providerMessageId,
      rfcMessageId,
      threadId,
      addHistoryId: historyId,
      direction: 'in',
      from: parsed.from,
      to: parsed.to ?? [this.address],
      cc: parsed.cc ?? [],
      subject: parsed.subject ?? '',
      snippet: parsed.snippet ?? this.deriveSnippet(parsed.bodyText, parsed.subject ?? ''),
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references ?? [],
      headers: {},
      labels: parsed.labels ?? [INBOX_LABEL],
      sentAt: parsed.sentAt ?? this.nowIso(),
      deleted: false,
    };
    this.commitMessage(stored);
    return this.toRawEmail(stored);
  }

  /** Change a message's labels (Gmail label add/remove → history `label` op). */
  setLabels(providerMessageId: string, labels: string[], atHistoryId?: number): void {
    const stored = this.messages.get(providerMessageId);
    if (stored === undefined || stored.deleted) throw new MessageNotFoundError(providerMessageId);
    stored.labels = [...labels];
    const historyId = this.allocateHistoryId(atHistoryId);
    this.history.push({ historyId, providerMessageId, op: 'label', labels: [...labels] });
  }

  /** Delete a message (Gmail message delete → history `delete` op). */
  deleteMessage(providerMessageId: string, atHistoryId?: number): void {
    const stored = this.messages.get(providerMessageId);
    if (stored === undefined || stored.deleted) throw new MessageNotFoundError(providerMessageId);
    stored.deleted = true;
    const historyId = this.allocateHistoryId(atHistoryId);
    this.history.push({ historyId, providerMessageId, op: 'delete', labels: [] });
  }

  /**
   * Expire history below `historyId`: any later `listHistory(cursor < historyId)`
   * throws `HistoryExpiredError`, forcing the RESYNC path (CONTRACTS §C5).
   */
  expireHistoryBefore(historyId: number): void {
    if (historyId > this.oldestHistoryId) this.oldestHistoryId = historyId;
  }

  /** Register a hook fired on every `send()` entry (pause-race scripting). */
  setSendInterceptor(interceptor: SendInterceptor | undefined): void {
    this.sendInterceptor = interceptor;
  }

  // --- Inspection (property-suite affordances) -----------------------------

  /** Total raw `send()` invocations (all keys). */
  get sendCallCount(): number {
    return this.totalSendCalls;
  }

  /** Raw `send()` invocations for one idempotency key (I-SEND-1 assertion). */
  sendCallCountForKey(key: string): number {
    return this.sendCallsByKey.get(key) ?? 0;
  }

  /** Distinct logical sends (idempotency dedupe applied). */
  get deliveredCount(): number {
    return this.sendLedger.size;
  }

  /** Current mailbox history head. */
  get headHistoryId(): number {
    return this.currentHistoryId;
  }

  /** Next contiguous history id (does not allocate). */
  nextHistoryId(): number {
    return this.currentHistoryId + 1;
  }

  /** Mint valid tokens for this mailbox (dev-login / test wiring). */
  mintTokens(scope = 'https://www.googleapis.com/auth/gmail.modify'): OAuthTokens {
    return this.mintTokensFor(this.address, scope);
  }

  private mintTokensFor(
    address: string,
    scope = 'https://www.googleapis.com/auth/gmail.modify',
  ): OAuthTokens {
    const expiresAt = new Date(this.clock.now().getTime() + 3600_000).toISOString();
    return {
      accessToken: `${MOCK_ACCESS_TOKEN_PREFIX}${address}`,
      refreshToken: `mock-refresh-${address}`,
      expiresAt,
      scope,
      tokenType: 'Bearer',
    };
  }

  lastWatchCallback(): string | undefined {
    return this.lastWatchCallbackUrl;
  }

  // --- internals -----------------------------------------------------------

  private commitMessage(stored: StoredMessage): void {
    this.messages.set(stored.providerMessageId, stored);
    this.byRfcId.set(stored.rfcMessageId, stored);
    this.history.push({
      historyId: stored.addHistoryId,
      providerMessageId: stored.providerMessageId,
      op: 'add',
      labels: [...stored.labels],
    });
  }

  private allocateHistoryId(requested?: number): number {
    if (requested === undefined) {
      this.currentHistoryId += 1;
      return this.currentHistoryId;
    }
    if (requested <= this.currentHistoryId) {
      throw new Error(
        `history id ${requested} must be strictly greater than head ${this.currentHistoryId}`,
      );
    }
    this.currentHistoryId = requested;
    return requested;
  }

  private resolveThreadId(inReplyTo?: string, references?: string[]): string {
    const candidates = [inReplyTo, ...(references ?? [])].filter(
      (r): r is string => r !== undefined,
    );
    for (const rfc of candidates) {
      const parent = this.byRfcId.get(rfc);
      if (parent !== undefined) return parent.threadId;
    }
    return this.ids.next('thread');
  }

  /**
   * Coalesce a page of raw history records into net per-message effects,
   * relative to the caller's `cursor`. A message added before the cursor is
   * "pre-existing"; one added within the page is "new". Add-then-delete inside
   * the page nets to nothing.
   */
  private coalescePage(
    records: HistoryRecord[],
    cursor: number,
  ): { added: HistoryMessage[]; deleted: MessageRef[]; labelsChanged: LabelChange[] } {
    const order: string[] = [];
    const grouped = new Map<string, HistoryRecord[]>();
    for (const rec of records) {
      const list = grouped.get(rec.providerMessageId);
      if (list === undefined) {
        grouped.set(rec.providerMessageId, [rec]);
        order.push(rec.providerMessageId);
      } else {
        list.push(rec);
      }
    }

    const added: HistoryMessage[] = [];
    const deleted: MessageRef[] = [];
    const labelsChanged: LabelChange[] = [];

    for (const messageId of order) {
      const ops = grouped.get(messageId)!;
      const stored = this.messages.get(messageId);
      const threadId = stored?.threadId ?? messageId;
      const existedBefore = stored !== undefined && stored.addHistoryId <= cursor;

      let present = existedBefore;
      let addedInWindow = false;
      let labelTouched = false;
      let labels: string[] = existedBefore ? (stored?.labels ?? []) : [];

      for (const op of ops) {
        if (op.op === 'add') {
          present = true;
          addedInWindow = true;
          labels = op.labels;
        } else if (op.op === 'delete') {
          present = false;
        } else {
          labelTouched = true;
          labels = op.labels;
        }
      }

      if (addedInWindow) {
        // New message: surfaces once (with final labels) iff still present.
        if (present) added.push({ providerMessageId: messageId, threadId, labels: [...labels] });
        // add-then-delete within the page → coalesced away (emit nothing).
        continue;
      }
      if (existedBefore && !present) {
        deleted.push({ providerMessageId: messageId, threadId });
      } else if (existedBefore && present && labelTouched) {
        labelsChanged.push({ providerMessageId: messageId, threadId, labels: [...labels] });
      }
    }

    return { added, deleted, labelsChanged };
  }

  private toRawEmail(stored: StoredMessage): RawEmail {
    return {
      providerMessageId: stored.providerMessageId,
      rfcMessageId: stored.rfcMessageId,
      threadId: stored.threadId,
      historyId: String(stored.addHistoryId),
      direction: stored.direction,
      from: stored.from,
      to: [...stored.to],
      cc: [...stored.cc],
      subject: stored.subject,
      snippet: stored.snippet,
      references: [...stored.references],
      headers: { ...stored.headers },
      labels: [...stored.labels],
      sentAt: stored.sentAt,
      ...(stored.bodyText !== undefined ? { bodyText: stored.bodyText } : {}),
      ...(stored.bodyHtml !== undefined ? { bodyHtml: stored.bodyHtml } : {}),
      ...(stored.inReplyTo !== undefined ? { inReplyTo: stored.inReplyTo } : {}),
    };
  }

  private parseCursor(cursor: string): number {
    const n = Number(cursor);
    if (!Number.isInteger(n) || n < 0) throw new Error(`mock listHistory: bad cursor ${cursor}`);
    return n;
  }

  private newRfcId(): string {
    return `<${this.ids.next('rfc')}@${this.address}>`;
  }

  private deriveSnippet(body: string | undefined, fallback: string): string {
    const source = body ?? fallback;
    return source.slice(0, 200);
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  private encodeOffsetToken(offset: number): string {
    return `o:${offset}`;
  }

  private decodeOffsetToken(token: string): number {
    if (!token.startsWith('o:')) throw new Error(`mock listMessages: bad pageToken ${token}`);
    const n = Number(token.slice(2));
    if (!Number.isInteger(n) || n < 0) throw new Error(`mock listMessages: bad pageToken ${token}`);
    return n;
  }
}
