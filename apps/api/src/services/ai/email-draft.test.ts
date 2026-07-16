import { describe, expect, test } from 'vitest';
import type { AIProvider } from '@switchboard/shared/providers';
import { createMockAIProvider } from '../../providers/ai/index.ts';
import { EmailDraftError, draftEmailForComposer } from './email-draft.ts';

/**
 * AI email drafting (task 3g). §I-AI: returned to the composer, NEVER sent. The
 * service takes only an `AIProvider` — it has no send dependency, so a draft cannot
 * become a send in this module. The suite pins that it returns a draft, forwards the
 * minimal thread context, and rejects an empty instruction.
 */

describe('draftEmailForComposer', () => {
  test('returns a composer draft; never sends', async () => {
    const ai = createMockAIProvider();
    const draft = await draftEmailForComposer(
      { ai },
      { instruction: 'Thank them for the call', threadCtx: { subject: 'Intro' } },
    );
    expect(draft.body).toContain('Thank them for the call');
    expect(draft.subject).toBe('Re: Intro');
  });

  test('forwards only the minimal thread context to the provider', async () => {
    const seen: { instruction: string; threadCtx: unknown }[] = [];
    const spy: AIProvider = {
      async summarizeCall() {
        return { summary: '', actionItems: [] };
      },
      async draftEmail(instruction, threadCtx) {
        seen.push({ instruction, threadCtx });
        return { body: 'ok' };
      },
      async nlToSmartView() {
        return { dsl: '' };
      },
    };
    await draftEmailForComposer(
      { ai: spy },
      {
        instruction: 'x',
        threadCtx: { subject: 'S', recentMessages: [{ from: 'a@b', body: 'hi' }] },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.threadCtx).toEqual({
      subject: 'S',
      recentMessages: [{ from: 'a@b', body: 'hi' }],
    });
  });

  test('works with no thread context (cold draft)', async () => {
    const ai = createMockAIProvider();
    const draft = await draftEmailForComposer({ ai }, { instruction: 'Cold outreach' });
    expect(draft.body).toContain('Cold outreach');
  });

  test('empty instruction → EmailDraftError (failure path)', async () => {
    const ai = createMockAIProvider();
    await expect(draftEmailForComposer({ ai }, { instruction: '   ' })).rejects.toBeInstanceOf(
      EmailDraftError,
    );
  });
});
