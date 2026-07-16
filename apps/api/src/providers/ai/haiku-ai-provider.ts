import { z } from 'zod';
import {
  callSummaryContextSchema,
  callSummarySchema,
  emailDraftSchema,
  emailThreadContextSchema,
  smartViewFieldCatalogSchema,
  smartViewSuggestionSchema,
  transcriptSchema,
  type AIProvider,
  type CallSummary,
  type SmartViewSuggestion,
  type Transcript,
} from '@switchboard/shared/providers';

/**
 * Real Anthropic (Claude Haiku 4.5) `AIProvider` (CONTRACTS §C2, ARCHITECTURE §7).
 * Used when `MOCK_MODE` is off; the mock (tasks 3e/3g) drives every feature test.
 * This adapter is exercised ONLY by its own unit tests, which inject a synthetic
 * {@link AnthropicTransport} returning a RECORDED Messages-API response — no network,
 * no Anthropic account — exactly like 2b's `GmailEmailProvider`. REAL-mode wiring
 * against live Haiku is a HUMAN_TODO checkpoint.
 *
 * Design:
 *  - All model I/O flows through the injected transport so tests supply canned JSON;
 *    the default `fetch` transport is a thin, untested-in-CI shell for production.
 *  - Model id `claude-haiku-4-5` (ARCHITECTURE §7). Haiku 4.5 does NOT accept the
 *    adaptive-thinking / effort params (they 400 on Haiku), so requests omit them.
 *  - `summarizeCall` / `draftEmail` use **structured outputs**
 *    (`output_config.format` json_schema — supported on Haiku 4.5) so the returned
 *    text is schema-valid JSON we re-validate with zod.
 *  - `nlToSmartView` asks for DSL TEXT only; the returned string is handed back
 *    verbatim and RE-PARSED by the feature with the shared parser (I-AI / §7: invalid
 *    DSL is a visible error, never a silent guess). The adapter never parses DSL.
 *  - A `stop_reason: "refusal"` (Claude safety decline) throws — the feature surfaces
 *    it rather than writing a guess. I-AI itself is enforced above the adapter line:
 *    this only produces candidates; the confirm step records `confirmedBy`.
 *
 * "Context sent to the provider is the minimum the feature needs" (§7): each method
 * parses its context operand against the minimal C2 DTO and sends only that.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const DEFAULT_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 1024;

// --- Transport seam ---------------------------------------------------------

export interface AnthropicTransportRequest {
  url: string;
  headers: Record<string, string>;
  /** JSON Messages-API request body. */
  body: string;
}

export interface AnthropicTransportResponse {
  status: number;
  body: string;
}

/** The HTTP seam. Tests inject a synthetic implementation; prod binds `fetch`. */
export interface AnthropicTransport {
  request(req: AnthropicTransportRequest): Promise<AnthropicTransportResponse>;
}

/** Thrown when the Messages API returns a non-2xx (engine wraps as C8 PROVIDER_ERROR). */
export class AnthropicApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AnthropicApiError';
    this.status = status;
  }
}

/** Thrown when Claude declines the request (`stop_reason: "refusal"`). */
export class AIRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIRefusalError';
  }
}

export interface HaikuAIConfig {
  apiKey: string;
  transport: AnthropicTransport;
  apiBase?: string;
  model?: string;
  maxTokens?: number;
}

// --- Messages-API response shape (only the fields we consume) ---------------

const messageResponseSchema = z.object({
  stop_reason: z.string().nullable().optional(),
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
      }),
    )
    .default([]),
});

const callSummaryJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    actionItems: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'actionItems'],
  additionalProperties: false,
} as const;

const emailDraftJsonSchema = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['body'],
  additionalProperties: false,
} as const;

export class HaikuAIProvider implements AIProvider {
  private readonly apiKey: string;
  private readonly transport: AnthropicTransport;
  private readonly apiBase: string;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(config: HaikuAIConfig) {
    if (config.apiKey.length === 0) throw new Error('anthropic: apiKey is required');
    this.apiKey = config.apiKey;
    this.transport = config.transport;
    this.apiBase = config.apiBase ?? DEFAULT_API_BASE;
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async summarizeCall(transcript: Transcript, ctx: unknown): Promise<CallSummary> {
    const t = transcriptSchema.parse(transcript);
    const context = callSummaryContextSchema.parse(ctx ?? {});
    const contextLine = [
      context.leadName !== undefined ? `Lead: ${context.leadName}` : undefined,
      context.contactName !== undefined ? `Contact: ${context.contactName}` : undefined,
      context.direction !== undefined ? `Direction: ${context.direction}` : undefined,
    ]
      .filter((s): s is string => s !== undefined)
      .join('; ');
    const system =
      'You summarize sales call transcripts for a CRM. Return a concise summary and a ' +
      'list of concrete action items for the rep. Do not invent facts not in the transcript.';
    const userText = `${contextLine.length > 0 ? contextLine + '\n\n' : ''}Transcript:\n${t.text}`;
    const text = await this.complete(system, userText, callSummaryJsonSchema);
    return callSummarySchema.parse(parseJson(text));
  }

  async draftEmail(instruction: string, threadCtx: unknown): Promise<{ subject?: string; body: string }> {
    if (instruction.length === 0) throw new Error('haiku draftEmail: empty instruction');
    const ctx = emailThreadContextSchema.parse(threadCtx ?? {});
    const excerpt =
      ctx.recentMessages.length > 0
        ? '\n\nRecent thread messages:\n' +
          ctx.recentMessages.map((m) => `${m.from}: ${m.body}`).join('\n')
        : '';
    const system =
      'You draft sales emails for a rep to review and send. Produce a subject and body. ' +
      'The draft is returned to the composer for the rep to edit — it is never sent automatically.';
    const userText = `Instruction: ${instruction}${
      ctx.subject !== undefined ? `\nThread subject: ${ctx.subject}` : ''
    }${excerpt}`;
    const text = await this.complete(system, userText, emailDraftJsonSchema);
    const draft = emailDraftSchema.parse(parseJson(text));
    // Narrow to the C2 exact-optional return shape (omit absent subject).
    return draft.subject !== undefined ? { subject: draft.subject, body: draft.body } : { body: draft.body };
  }

  async nlToSmartView(query: string, fieldCatalog: unknown): Promise<SmartViewSuggestion> {
    if (query.length === 0) throw new Error('haiku nlToSmartView: empty query');
    const catalog = smartViewFieldCatalogSchema.parse(fieldCatalog ?? { builtins: [], custom: [] });
    const fieldLines = [
      `Builtin fields: ${catalog.builtins.join(', ')}`,
      catalog.custom.length > 0
        ? `Custom fields (reference as custom.<key>): ${catalog.custom
            .map((c) => `${c.key} (${c.type})`)
            .join(', ')}`
        : undefined,
    ]
      .filter((s): s is string => s !== undefined)
      .join('\n');
    const system =
      'You translate a natural-language lead query into the Switchboard Smart View DSL. ' +
      'Output ONLY the DSL expression — no prose, no code fences, no explanation. ' +
      'Reference only the fields listed. If unsure, prefer a matches "..." full-text clause.';
    const userText = `${fieldLines}\n\nQuery: ${query}`;
    // No structured output here: DSL is free text, re-parsed by the shared parser.
    const text = await this.complete(system, userText, undefined);
    return smartViewSuggestionSchema.parse({ dsl: text.trim() });
  }

  // --- internals -----------------------------------------------------------

  private async complete(
    system: string,
    userText: string,
    jsonSchema: Record<string, unknown> | undefined,
  ): Promise<string> {
    const requestBody: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: 'user', content: userText }],
    };
    if (jsonSchema !== undefined) {
      requestBody.output_config = { format: { type: 'json_schema', schema: jsonSchema } };
    }
    const res = await this.transport.request({
      url: `${this.apiBase}/v1/messages`,
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new AnthropicApiError(res.status, `anthropic messages failed with status ${res.status}`);
    }
    const parsed = messageResponseSchema.parse(JSON.parse(res.body));
    if (parsed.stop_reason === 'refusal') {
      throw new AIRefusalError('Claude declined to produce this output');
    }
    const text = parsed.content
      .filter((b) => b.type === 'text' && b.text !== undefined)
      .map((b) => b.text ?? '')
      .join('');
    if (text.length === 0) throw new AnthropicApiError(res.status, 'anthropic returned no text');
    return text;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AnthropicApiError(200, 'anthropic structured output was not valid JSON');
  }
}

/** Production HTTP transport over global `fetch` (never exercised by the suite). */
export class FetchAnthropicTransport implements AnthropicTransport {
  async request(req: AnthropicTransportRequest): Promise<AnthropicTransportResponse> {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    return { status: res.status, body: await res.text() };
  }
}

/** Factory the composition root binds when `MOCK_MODE` is off (real Haiku). */
export function createHaikuAIProvider(config: HaikuAIConfig): HaikuAIProvider {
  return new HaikuAIProvider(config);
}
