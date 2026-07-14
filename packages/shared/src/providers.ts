/**
 * External provider interfaces (CONTRACTS §C2). All external I/O flows through
 * these four adapters; `MOCK_MODE=1` binds mock implementations with identical
 * signatures. This file declares the interface contracts only — concrete DTO
 * shapes and implementations land with the adapters in Phase 2–3.
 *
 * The DTO aliases below are intentionally `unknown` placeholders: they are
 * replaced by zod-inferred types when each adapter is implemented, without
 * changing these method signatures.
 */

export type OAuthTokens = unknown;
export type HistoryPage = unknown;
export type MessagePage = unknown;
export type RawEmail = unknown;
export type OutboundEmail = unknown;
export type BrowserCallToken = unknown;
export type Transcript = unknown;

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
