/**
 * External provider interfaces (CONTRACTS §C2). All external I/O flows through
 * these four adapters; `MOCK_MODE=1` binds mock implementations with identical
 * signatures. This file owns both the interface contracts and the zod-typed DTO
 * shapes the email interface exchanges (task 2a) plus the telephony DTOs the C2
 * `TelephonyProvider` signatures reference (task 3a — appended at the end). ASR/AI
 * DTOs stay as `unknown` placeholders until their adapters land (tasks 3c+).
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
  getMailboxAddress(tokens: OAuthTokens): Promise<string>;
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

// The `Transcript` DTO the ASR/AI interfaces reference is defined in the appended
// AI/ASR section at the file tail (tasks 3e/3g). A `typeof` reference resolves
// module-wide, so the interfaces below type-check against the concrete shape while
// the schema itself stays at the tail (append-only merge). The C2 method signatures
// below are frozen; `ctx`/`threadCtx`/`fieldCatalog` stay `unknown` at the interface
// boundary (the adapters parse them internally against the appended DTO schemas).
export type Transcript = z.infer<typeof transcriptSchema>;

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

// ===========================================================================
// Telephony DTOs (CONTRACTS §C2 TelephonyProvider · §C4 call/sms events · §C6
// I-REC/I-QUIET/I-DNC). Appended by task 3a. The C2 method signatures above are
// frozen; these are the shapes they reference plus the scripted call-lifecycle /
// inbound-SMS event unions the `MockTelephonyProvider` replays. Kept at the file
// tail so the append is a trivial (conflict-free) merge.
// ===========================================================================

/**
 * Browser-side calling credential returned by `createCallToken` (the Twilio Voice
 * JS SDK access token in real mode). `identity` is the client identity the token
 * is minted for (the CRM user id); `expiresAt` is absolute (ISO-8601 UTC).
 */
export const browserCallTokenSchema = z.object({
  token: z.string().min(1),
  identity: z.string().min(1),
  expiresAt: z.string().datetime(),
  ttlSeconds: z.number().int().positive(),
});
export type BrowserCallToken = z.infer<typeof browserCallTokenSchema>;

/**
 * Per-call switches passed to `dial` (CONTRACTS §C2). `record` requests call
 * recording; `consentAnnouncement` requests the pre-recording consent line be
 * played. §I-REC: recording is only ever armed when a consent announcement
 * precedes it on that call — the adapter never records without one.
 */
export const dialOptionsSchema = z.object({
  record: z.boolean(),
  consentAnnouncement: z.boolean(),
});
export type DialOptions = z.infer<typeof dialOptionsSchema>;

/** `dial()` result — the provider call id keyed into `calls.twilio_sid` (§C1). */
export const dialResultSchema = z.object({
  callSid: z.string().min(1),
});
export type DialResult = z.infer<typeof dialResultSchema>;

/** `sendSms()` result — the provider id keyed into `sms_messages.provider_sid`. */
export const smsResultSchema = z.object({
  sid: z.string().min(1),
});
export type SmsResult = z.infer<typeof smsResultSchema>;

/**
 * Record of a `dropVoicemail` (CONTRACTS §C2): a pre-recorded voicemail dropped
 * into a live outbound call that reached the callee's machine. `recordingRef` is
 * the rep's own pre-recorded asset — not a consent-gated conversation recording,
 * so it is never subject to §I-REC.
 */
export const voicemailDropSchema = z.object({
  callSid: z.string().min(1),
  recordingRef: z.string().min(1),
  at: z.string().datetime(),
});
export type VoicemailDrop = z.infer<typeof voicemailDropSchema>;

/**
 * The `type` discriminants of a call-lifecycle event: the `calls.status` vocab
 * (§C1) plus the recording/consent markers §I-REC and the §C4 event taxonomy
 * (`recording_consent_played`) require. `recording_started`/`recording_completed`
 * are the only "recording ref" carriers on a live call — §I-REC gates them behind
 * a preceding `recording_consent_played`.
 */
export const callLifecycleTypeSchema = z.enum([
  'queued',
  'ringing',
  'recording_consent_played',
  'answered',
  'recording_started',
  'recording_completed',
  'completed',
  'failed',
  'voicemail',
  'missed',
]);
export type CallLifecycleType = z.infer<typeof callLifecycleTypeSchema>;

// Fields carried by every lifecycle event. `sequence` is the 0-based ordinal
// within one call's stream; `at` is provider time (ISO-8601 UTC), driven by the
// mock's injected clock so a scripted stream replays byte-identically.
const callEventBase = {
  callSid: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  at: z.string().datetime(),
} as const;

/**
 * One event in a call's webhook lifecycle stream (Twilio voice status + recording
 * status callbacks, normalized). A `dial()` emits an ordered stream of these; the
 * mock replays a scripted or opts-derived stream. Discriminated on `type`.
 *
 * §I-REC is expressed structurally: `recording_started`/`recording_completed`
 * (the recording-ref carriers) appear on a call only after a
 * `recording_consent_played` marker; `voicemail.recordingRef` is a caller's
 * inbound message and `VoicemailDrop.recordingRef` is the rep's own asset —
 * neither is a consent-gated conversation recording.
 */
export const callLifecycleEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('queued'), ...callEventBase }),
  z.object({ type: z.literal('ringing'), ...callEventBase }),
  z.object({ type: z.literal('recording_consent_played'), ...callEventBase }),
  z.object({ type: z.literal('answered'), ...callEventBase }),
  z.object({
    type: z.literal('recording_started'),
    ...callEventBase,
    recordingSid: z.string().min(1),
  }),
  z.object({
    type: z.literal('recording_completed'),
    ...callEventBase,
    recordingSid: z.string().min(1),
    recordingRef: z.string().min(1),
    durationS: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('completed'),
    ...callEventBase,
    durationS: z.number().int().nonnegative(),
    voicemailDropped: z.boolean(),
  }),
  z.object({ type: z.literal('failed'), ...callEventBase, reason: z.string().min(1) }),
  z.object({
    type: z.literal('voicemail'),
    ...callEventBase,
    recordingRef: z.string().min(1),
    recordingDurationS: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('missed'), ...callEventBase }),
]);
export type CallLifecycleEvent = z.infer<typeof callLifecycleEventSchema>;

/**
 * A parsed inbound SMS (Twilio `/wh/twilio/sms`). §I-QUIET: a body of
 * STOP/UNSUBSCRIBE/QUIT/CANCEL/END is an opt-out — the engine classifies it via
 * the telephony adapter's `matchOptOutKeyword` helper; this DTO stays raw so the
 * classification lives in exactly one place.
 */
export const inboundSmsEventSchema = z.object({
  messageSid: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  body: z.string(),
  numMedia: z.number().int().nonnegative(),
  receivedAt: z.string().datetime(),
});
export type InboundSmsEvent = z.infer<typeof inboundSmsEventSchema>;

// ===========================================================================
// ASR / AI DTOs (CONTRACTS §C2 ASRProvider/AIProvider · ARCHITECTURE §7 AI paths ·
// §C6 I-AI). Appended by tasks 3e/3g. The C2 method signatures earlier in this
// file are frozen — these are the concrete shapes they reference (`Transcript`)
// plus the result / context DTOs the mock + real adapters validate against.
// Kept at the file tail so the append is a trivial (conflict-free) merge.
//
// I-AI is a *service/route* invariant, not a provider one: these adapters only
// PRODUCE candidate output. Nothing here writes a record — the confirm step lives
// in `services/ai` + `routes/ai.ts`, which is where `confirmedBy` is recorded.
// ===========================================================================

/** A speaker turn in a call transcript. `speaker` is best-effort diarization. */
export const transcriptSegmentSchema = z.object({
  speaker: z.enum(['agent', 'customer', 'unknown']),
  text: z.string(),
  /** Segment start/end offset from call start, in seconds. */
  startS: z.number().nonnegative(),
  endS: z.number().nonnegative(),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

/**
 * The `ASRProvider.transcribe` result (CONTRACTS §C2) and the input to
 * `AIProvider.summarizeCall`. `text` is the flattened transcript; `segments` is
 * the diarized turn list. Deterministic in the mock (canned/derived), produced by
 * Deepgram in real mode. `durationS`/`language` are best-effort metadata.
 */
export const transcriptSchema = z.object({
  text: z.string(),
  segments: z.array(transcriptSegmentSchema),
  durationS: z.number().nonnegative().optional(),
  language: z.string().optional(),
});
// `Transcript` is exported near the interface declarations (typed off this schema).

/**
 * Minimal call context handed to `AIProvider.summarizeCall` (the `ctx` operand of
 * the frozen C2 signature). "Context sent to the provider is the minimum the
 * feature needs" (ARCHITECTURE §7): identity labels + direction only — never the
 * full lead record. The interface types `ctx` as `unknown`; the adapter parses it
 * against this schema so the shape lives in exactly one place.
 */
export const callSummaryContextSchema = z.object({
  leadName: z.string().optional(),
  contactName: z.string().optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
});
export type CallSummaryContext = z.infer<typeof callSummaryContextSchema>;

/** `summarizeCall` result (CONTRACTS §C2). `actionItems` are free-text follow-ups. */
export const callSummarySchema = z.object({
  summary: z.string(),
  actionItems: z.array(z.string()),
});
export type CallSummary = z.infer<typeof callSummarySchema>;

/**
 * Minimal thread context handed to `AIProvider.draftEmail` (the `threadCtx` operand
 * of the frozen C2 signature). Just the thread subject and a bounded excerpt of the
 * most recent messages — the minimum a draft needs (ARCHITECTURE §7).
 */
export const emailThreadContextSchema = z.object({
  subject: z.string().optional(),
  recentMessages: z
    .array(
      z.object({
        from: z.string(),
        body: z.string(),
      }),
    )
    .default([]),
});
export type EmailThreadContext = z.infer<typeof emailThreadContextSchema>;

/** `draftEmail` result (CONTRACTS §C2). Returned to the composer — never auto-sent. */
export const emailDraftSchema = z.object({
  subject: z.string().optional(),
  body: z.string(),
});
export type EmailDraft = z.infer<typeof emailDraftSchema>;

/** One custom field exposed to NL→Smart View so the model can reference it. */
export const smartViewCatalogFieldSchema = z.object({
  key: z.string(),
  type: z.enum(['text', 'number', 'date', 'select', 'user']),
  label: z.string().optional(),
});
export type SmartViewCatalogField = z.infer<typeof smartViewCatalogFieldSchema>;

/**
 * The `fieldCatalog` operand of `AIProvider.nlToSmartView` (frozen C2 signature):
 * the "schema-of-fields" — the minimum the feature needs (ARCHITECTURE §7). Builtin
 * field names plus the org's custom fields, so the model emits DSL that references
 * only real fields. The emitted DSL is RE-PARSED by the same parser as user input,
 * so an out-of-catalog reference surfaces as a visible parse error, never a guess.
 */
export const smartViewFieldCatalogSchema = z.object({
  builtins: z.array(z.string()),
  custom: z.array(smartViewCatalogFieldSchema).default([]),
});
export type SmartViewFieldCatalog = z.infer<typeof smartViewFieldCatalogSchema>;

/** `nlToSmartView` result (CONTRACTS §C2). `dsl` MUST be re-parsed by the caller. */
export const smartViewSuggestionSchema = z.object({
  dsl: z.string(),
});
export type SmartViewSuggestion = z.infer<typeof smartViewSuggestionSchema>;
