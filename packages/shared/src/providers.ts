/**
 * External provider interfaces (CONTRACTS §C2). All external I/O flows through
 * these four adapters; `MOCK_MODE=1` binds mock implementations with identical
 * signatures. This file owns both the interface contracts and the zod-typed DTO
 * shapes the email interface exchanges (task 2a). Telephony/ASR/AI DTOs stay as
 * `unknown` placeholders until their adapters land (tasks 3x).
 *
 * Zod schema = runtime contract; the exported TS type is inferred from it and
 * never hand-written (CONTRACTS intro). The C2 method signatures below are
 * frozen — 2a only fills in the DTO types they reference.
 */

import { z } from 'zod';
import { emailDirectionSchema } from './domain.ts';

// ---------------------------------------------------------------------------
// Email DTOs (CONTRACTS §C2 EmailProvider)
// ---------------------------------------------------------------------------

/**
 * OAuth credential bundle for a linked mailbox. Stored encrypted at rest
 * (`email_accounts.oauth_tokens`, CONTRACTS §C1); adapters receive the decrypted
 * shape. `expiresAt` is the absolute access-token expiry (ISO-8601 UTC).
 */
export const oauthTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string().datetime(),
  scope: z.string(),
  tokenType: z.string().default('Bearer'),
});
export type OAuthTokens = z.infer<typeof oauthTokensSchema>;

/**
 * A composed outbound message handed to `send()`. `headers` carries provider
 * headers the send path is responsible for (e.g. `List-Unsubscribe` for
 * sequence email — CONTRACTS §I-SEND-5); the provider does not synthesise them.
 */
export const outboundEmailSchema = z.object({
  to: z.array(z.string().min(1)).min(1),
  cc: z.array(z.string().min(1)).optional(),
  bcc: z.array(z.string().min(1)).optional(),
  subject: z.string(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  headers: z.record(z.string()).optional(),
});
export type OutboundEmail = z.infer<typeof outboundEmailSchema>;

/**
 * A fully-fetched message (`getMessage`). `historyId` is the mailbox history id
 * at which the message became visible (string per Gmail / `history_cursor text`,
 * CONTRACTS §C1). `rfcMessageId` is the RFC-5322 `Message-ID` — the cross-mailbox
 * dedupe key (CONTRACTS §C1 `UNIQUE (account_id, rfc_message_id)`).
 */
export const rawEmailSchema = z.object({
  providerMessageId: z.string(),
  rfcMessageId: z.string(),
  threadId: z.string(),
  historyId: z.string(),
  direction: emailDirectionSchema,
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  snippet: z.string(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()),
  headers: z.record(z.string()),
  labels: z.array(z.string()),
  sentAt: z.string().datetime(),
});
export type RawEmail = z.infer<typeof rawEmailSchema>;

/** Light message reference (ids only) — Gmail `messages.list` / history shape. */
export const messageRefSchema = z.object({
  providerMessageId: z.string(),
  threadId: z.string(),
});
export type MessageRef = z.infer<typeof messageRefSchema>;

/**
 * One page of the backfill import (`listMessages`). `historyId` is the mailbox's
 * current history id at page time — the BACKFILLING→LIVE handoff snapshots it as
 * the live cursor (ARCHITECTURE §3). `nextPageToken` absent ⇒ last page.
 */
export const messagePageSchema = z.object({
  messages: z.array(messageRefSchema),
  nextPageToken: z.string().optional(),
  historyId: z.string(),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

/** A message add carried by a history page, with its final (coalesced) labels. */
export const historyMessageSchema = z.object({
  providerMessageId: z.string(),
  threadId: z.string(),
  labels: z.array(z.string()),
});
export type HistoryMessage = z.infer<typeof historyMessageSchema>;

/** A label change on a pre-existing message, coalesced to the final label set. */
export const labelChangeSchema = z.object({
  providerMessageId: z.string(),
  threadId: z.string(),
  labels: z.array(z.string()),
});
export type LabelChange = z.infer<typeof labelChangeSchema>;

/**
 * One page of incremental history (`listHistory`). Changes are COALESCED within
 * the page: multiple mutations to the same message collapse to a single net
 * effect (add-then-delete nets to nothing; add-then-label yields one add with
 * final labels). `historyId` is the cursor the caller advances to after applying
 * this page (transactionally with the writes — CONTRACTS §C5). `nextPageToken`
 * absent ⇒ caller is caught up to `historyId`.
 */
export const historyPageSchema = z.object({
  historyId: z.string(),
  nextPageToken: z.string().optional(),
  messagesAdded: z.array(historyMessageSchema),
  messagesDeleted: z.array(messageRefSchema),
  labelsChanged: z.array(labelChangeSchema),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

/** `send()` result — the provider ids the sync/event writer keys off. */
export const sendResultSchema = z.object({
  providerMessageId: z.string(),
  rfcMessageId: z.string(),
});
export type SendResult = z.infer<typeof sendResultSchema>;

/**
 * Scripting input for `MockEmailProvider.injectIncoming` (CONTRACTS §C2 hook).
 * Only `from` is required; the mock fills provider ids, thread linkage,
 * `snippet`, and defaults. Not part of the real Gmail adapter surface.
 */
export const incomingEmailSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  snippet: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  rfcMessageId: z.string().optional(),
  threadId: z.string().optional(),
  labels: z.array(z.string()).optional(),
  sentAt: z.string().datetime().optional(),
});
export type IncomingEmail = z.infer<typeof incomingEmailSchema>;

// ---------------------------------------------------------------------------
// Typed provider errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `listHistory` when the supplied cursor predates the oldest retained
 * history id (Gmail 404 / "historyId too old"). Forces the RESYNC path
 * (ARCHITECTURE §3, CONTRACTS §C5). Injectable in the mock.
 */
export class HistoryExpiredError extends Error {
  readonly cursor: string;
  readonly oldestHistoryId: string;
  constructor(cursor: string, oldestHistoryId: string) {
    super(`history id ${cursor} is older than the oldest retained id ${oldestHistoryId}`);
    this.name = 'HistoryExpiredError';
    this.cursor = cursor;
    this.oldestHistoryId = oldestHistoryId;
  }
}

/** Thrown by `getMessage` for an unknown/purged provider message id. */
export class MessageNotFoundError extends Error {
  readonly providerMessageId: string;
  constructor(providerMessageId: string) {
    super(`no message with provider id ${providerMessageId}`);
    this.name = 'MessageNotFoundError';
    this.providerMessageId = providerMessageId;
  }
}

// ---------------------------------------------------------------------------
// Provider interfaces (CONTRACTS §C2 — signatures frozen)
// ---------------------------------------------------------------------------

export interface EmailProvider {
  getAuthUrl(accountHint: string, redirectUri: string): Promise<string>;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens>;
  listHistory(tokens: OAuthTokens, cursor: string): Promise<HistoryPage>;
  listMessages(tokens: OAuthTokens, pageToken?: string): Promise<MessagePage>;
  getMessage(tokens: OAuthTokens, providerMessageId: string): Promise<RawEmail>;
  send(
    tokens: OAuthTokens,
    draft: OutboundEmail,
    idempotencyKey: string,
  ): Promise<{ providerMessageId: string; rfcMessageId: string }>;
  watch(tokens: OAuthTokens, callbackUrl: string): Promise<{ expiresAt: string }>;
}

// Telephony/ASR/AI DTOs are declared with their adapters (tasks 3x); placeholders
// keep the interfaces compiling without asserting a premature shape.
export type BrowserCallToken = unknown;
export type Transcript = unknown;

export interface TelephonyProvider {
  createCallToken(userId: string): Promise<BrowserCallToken>;
  dial(
    from: string,
    to: string,
    opts: { record: boolean; consentAnnouncement: boolean },
  ): Promise<{ callSid: string }>;
  sendSms(from: string, to: string, body: string, idempotencyKey: string): Promise<{ sid: string }>;
  verifyWebhook(headers: Record<string, string>, rawBody: string, url: string): boolean;
  dropVoicemail(callSid: string, recordingRef: string): Promise<void>;
}

export interface ASRProvider {
  transcribe(audioRef: string): Promise<Transcript>;
}

export interface AIProvider {
  summarizeCall(
    transcript: Transcript,
    ctx: unknown,
  ): Promise<{ summary: string; actionItems: string[] }>;
  draftEmail(instruction: string, threadCtx: unknown): Promise<{ subject?: string; body: string }>;
  nlToSmartView(query: string, fieldCatalog: unknown): Promise<{ dsl: string }>;
}
