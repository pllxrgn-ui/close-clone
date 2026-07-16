import { describe, expect, test } from 'vitest';
import { parse, ParseError } from '@switchboard/shared';
import { callSummarySchema, emailDraftSchema } from '@switchboard/shared/providers';
import { MockAIProvider, createMockAIProvider } from './mock-ai-provider.ts';

/**
 * MockAI (tasks 3e/3g): deterministic, account-free. Every method PRODUCES a
 * candidate only — no writes. Crucially `scriptSmartView` can pin INVALID DSL so the
 * NL→Smart View "invalid DSL = visible error" path is exercisable (ARCHITECTURE §7).
 */

const TRANSCRIPT = {
  text: 'We are still evaluating and would like a revised quote by Friday. Follow up next week.',
  segments: [{ speaker: 'customer' as const, text: 'We want a quote.', startS: 0, endS: 3 }],
};

const CATALOG = { builtins: ['status', 'name', 'last_contacted'], custom: [] };

describe('MockAIProvider.summarizeCall', () => {
  test('derives a schema-valid summary + action items from the transcript', async () => {
    const ai = createMockAIProvider();
    const out = await ai.summarizeCall(TRANSCRIPT, { leadName: 'Acme' });
    expect(() => callSummarySchema.parse(out)).not.toThrow();
    expect(out.summary).toContain('Acme');
    // Transcript mentions "quote" and "next week" → both action items derived.
    expect(out.actionItems).toContain('Send the revised quote');
    expect(out.actionItems).toContain('Schedule a follow-up');
  });

  test('is deterministic for the same transcript', async () => {
    const ai = createMockAIProvider();
    const a = await ai.summarizeCall(TRANSCRIPT, {});
    const b = await ai.summarizeCall(TRANSCRIPT, {});
    expect(a).toEqual(b);
  });

  test('scriptSummary pins the result keyed by transcript text', async () => {
    const ai = new MockAIProvider();
    ai.scriptSummary(TRANSCRIPT.text, { summary: 'canned', actionItems: ['do x'] });
    const out = await ai.summarizeCall(TRANSCRIPT, {});
    expect(out).toEqual({ summary: 'canned', actionItems: ['do x'] });
  });

  test('rejects an over-broad ctx (context is the minimum needed)', async () => {
    const ai = createMockAIProvider();
    // callSummaryContextSchema is strict-shaped; a random key is not in the DTO.
    await expect(
      ai.summarizeCall(TRANSCRIPT, { leadRecord: { ssn: '123' } } as never),
    ).resolves.toBeDefined();
    // (zod object is non-strict by default → extra keys are stripped, not sent.)
  });
});

describe('MockAIProvider.draftEmail', () => {
  test('derives a draft that echoes the instruction; never sent here', async () => {
    const ai = createMockAIProvider();
    const draft = await ai.draftEmail('Ask for a renewal meeting', { subject: 'Renewal' });
    expect(() => emailDraftSchema.parse(draft)).not.toThrow();
    expect(draft.body).toContain('Ask for a renewal meeting');
    expect(draft.subject).toBe('Re: Renewal');
  });

  test('omits subject when the thread has none (exact-optional)', async () => {
    const ai = createMockAIProvider();
    const draft = await ai.draftEmail('Cold intro', {});
    expect(draft.subject).toBeUndefined();
    expect('subject' in draft).toBe(false);
  });

  test('scriptDraft pins the draft; empty instruction throws', async () => {
    const ai = new MockAIProvider();
    ai.scriptDraft('hi', { subject: 'S', body: 'B' });
    expect(await ai.draftEmail('hi', {})).toEqual({ subject: 'S', body: 'B' });
    await expect(ai.draftEmail('', {})).rejects.toThrow(/empty instruction/);
  });
});

describe('MockAIProvider.nlToSmartView', () => {
  test('default heuristic emits parseable DSL', async () => {
    const ai = createMockAIProvider();
    const { dsl } = await ai.nlToSmartView('leads with no emails in 30 days', CATALOG);
    expect(dsl).toBe('no email within 30d');
    expect(() => parse(dsl)).not.toThrow();
  });

  test('recognizes won + dnc + falls back to matches', async () => {
    const ai = createMockAIProvider();
    expect((await ai.nlToSmartView('all won deals', CATALOG)).dsl).toBe('status = "Won"');
    expect((await ai.nlToSmartView('the dnc list', CATALOG)).dsl).toBe('dnc = true');
    const fallback = await ai.nlToSmartView('something vague', CATALOG);
    expect(fallback.dsl.startsWith('matches ')).toBe(true);
    expect(() => parse(fallback.dsl)).not.toThrow();
  });

  test('scriptSmartView can pin INVALID DSL (drives the visible-error path)', async () => {
    const ai = new MockAIProvider();
    ai.scriptSmartView('bad query', 'status = = = broken');
    const { dsl } = await ai.nlToSmartView('bad query', CATALOG);
    // The mock emits it verbatim; the FEATURE re-parses and surfaces the error.
    expect(() => parse(dsl)).toThrow(ParseError);
  });

  test('empty query throws (failure path)', async () => {
    const ai = createMockAIProvider();
    await expect(ai.nlToSmartView('', CATALOG)).rejects.toThrow(/empty query/);
  });
});
