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
  type EmailDraft,
  type SmartViewSuggestion,
  type Transcript,
} from '@switchboard/shared/providers';

/**
 * In-memory `AIProvider` (CONTRACTS §C2, ARCHITECTURE §7) for MOCK_MODE and the
 * AI-feature suites (tasks 3e/3g). Deterministic and account-free: no Haiku, no
 * network. Every method PRODUCES a candidate only — I-AI (no AI output reaches a
 * final record / a send without a user confirm carrying `confirmedBy`) is enforced
 * by `services/ai` + `routes/ai.ts`, never here.
 *
 * Test instruments (mirroring MockEmail/MockTelephony scripting hooks):
 *  - `scriptSummary(key, {summary, actionItems})`
 *  - `scriptDraft(key, {subject?, body})`
 *  - `scriptSmartView(query, dsl)` — pins the raw DSL text the model "emits" for a
 *    query. Crucially, the text may be INVALID DSL: the NL→Smart View feature
 *    re-parses the model output with the shared parser, so a bad string must be
 *    scriptable to exercise the "invalid DSL = visible error" path (ARCHITECTURE §7).
 *
 * Absent a script each method derives a stable, deterministic result from its
 * inputs, so replays are byte-identical and MOCK_MODE is demo-usable.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface MockAIProviderOptions {
  summaries?: Record<string, CallSummary>;
  drafts?: Record<string, EmailDraft>;
  smartViews?: Record<string, string>;
}

export class MockAIProvider implements AIProvider {
  private readonly scriptedSummaries: Map<string, CallSummary>;
  private readonly scriptedDrafts: Map<string, EmailDraft>;
  private readonly scriptedSmartViews: Map<string, string>;
  private summarizeCalls = 0;
  private draftCalls = 0;
  private smartViewCalls = 0;

  constructor(options: MockAIProviderOptions = {}) {
    this.scriptedSummaries = new Map(Object.entries(options.summaries ?? {}));
    this.scriptedDrafts = new Map(Object.entries(options.drafts ?? {}));
    this.scriptedSmartViews = new Map(Object.entries(options.smartViews ?? {}));
  }

  scriptSummary(key: string, summary: CallSummary): void {
    this.scriptedSummaries.set(key, callSummarySchema.parse(summary));
  }

  scriptDraft(key: string, draft: EmailDraft): void {
    this.scriptedDrafts.set(key, emailDraftSchema.parse(draft));
  }

  /** Pin the raw DSL text the model emits for a query (valid OR invalid). */
  scriptSmartView(query: string, dsl: string): void {
    this.scriptedSmartViews.set(query, dsl);
  }

  get calls(): { summarize: number; draft: number; smartView: number } {
    return {
      summarize: this.summarizeCalls,
      draft: this.draftCalls,
      smartView: this.smartViewCalls,
    };
  }

  async summarizeCall(transcript: Transcript, ctx: unknown): Promise<CallSummary> {
    this.summarizeCalls += 1;
    const parsed = transcriptSchema.parse(transcript);
    // Parse ctx against the minimal DTO so an over-broad payload is rejected here,
    // exactly as the real Haiku adapter would (context is the minimum needed).
    const context = callSummaryContextSchema.parse(ctx ?? {});
    const scripted = this.scriptedSummaries.get(parsed.text);
    if (scripted !== undefined) return scripted;
    return deriveSummary(parsed, context.leadName);
  }

  async draftEmail(
    instruction: string,
    threadCtx: unknown,
  ): Promise<{ subject?: string; body: string }> {
    this.draftCalls += 1;
    if (instruction.length === 0) throw new Error('mock AI draftEmail: empty instruction');
    const ctx = emailThreadContextSchema.parse(threadCtx ?? {});
    const scripted = this.scriptedDrafts.get(instruction);
    return normalizeDraft(scripted ?? deriveDraft(instruction, ctx.subject));
  }

  async nlToSmartView(query: string, fieldCatalog: unknown): Promise<SmartViewSuggestion> {
    this.smartViewCalls += 1;
    if (query.length === 0) throw new Error('mock AI nlToSmartView: empty query');
    // Validate the catalog shape (the minimum context the feature needs).
    smartViewFieldCatalogSchema.parse(fieldCatalog ?? { builtins: [], custom: [] });
    const scripted = this.scriptedSmartViews.get(query);
    if (scripted !== undefined) return smartViewSuggestionSchema.parse({ dsl: scripted });
    return smartViewSuggestionSchema.parse({ dsl: deriveDsl(query) });
  }
}

function deriveSummary(transcript: Transcript, leadName: string | undefined): CallSummary {
  const who = leadName !== undefined && leadName.length > 0 ? ` with ${leadName}` : '';
  const summary = `Call${who} covered the customer's current evaluation status and next steps. ${firstSentence(
    transcript.text,
  )}`;
  const actionItems: string[] = [];
  const lower = transcript.text.toLowerCase();
  if (lower.includes('quote')) actionItems.push('Send the revised quote');
  if (lower.includes('follow-up') || lower.includes('follow up') || lower.includes('next week')) {
    actionItems.push('Schedule a follow-up');
  }
  if (actionItems.length === 0) actionItems.push('Log call outcome and next step');
  return callSummarySchema.parse({ summary, actionItems });
}

function firstSentence(text: string): string {
  const match = text.match(/[^.!?]*[.!?]/);
  return (match?.[0] ?? text).trim();
}

/**
 * Narrow an {@link EmailDraft} (`subject?: string | undefined`) to the C2 interface
 * return shape (`subject?: string`, exact-optional): omit `subject` when absent so
 * the value satisfies `AIProvider.draftEmail` under exactOptionalPropertyTypes.
 */
function normalizeDraft(draft: EmailDraft): { subject?: string; body: string } {
  return draft.subject !== undefined
    ? { subject: draft.subject, body: draft.body }
    : { body: draft.body };
}

function deriveDraft(instruction: string, subject: string | undefined): EmailDraft {
  const replySubject =
    subject !== undefined && subject.length > 0
      ? subject.startsWith('Re:')
        ? subject
        : `Re: ${subject}`
      : undefined;
  const body = `Hi,\n\n${instruction.trim()}\n\nBest regards,\n`;
  return emailDraftSchema.parse(
    replySubject === undefined ? { body } : { subject: replySubject, body },
  );
}

/**
 * Deterministic query→DSL heuristic. A handful of recognized shapes plus a default
 * that falls back to a global full-text `matches` clause — always valid DSL, so the
 * default path yields a parseable suggestion. The service re-parses regardless.
 */
function deriveDsl(query: string): string {
  const q = query.toLowerCase();
  const won = q.match(/\b(won|closed[- ]won)\b/);
  if (won) return 'status = "Won"';
  const noEmail = q.match(/no (?:email|emails?)[^0-9]*(\d+)\s*(day|days|week|weeks)/);
  if (noEmail) {
    const n = noEmail[1];
    const unit = noEmail[2]?.startsWith('week') ? 'w' : 'd';
    return `no email within ${n}${unit}`;
  }
  if (q.includes('do not call') || q.includes('dnc')) return 'dnc = true';
  return `matches ${JSON.stringify(query)}`;
}

/** Factory the composition root binds under `MOCK_MODE=1`. */
export function createMockAIProvider(options: MockAIProviderOptions = {}): MockAIProvider {
  return new MockAIProvider(options);
}
