import { describe, expect, test } from 'vitest';
import { astToDsl } from '@switchboard/shared';
import { createMockAIProvider } from '../../providers/ai/index.ts';
import { NlToSmartViewError, nlToSmartView } from './nl-to-smart-view.ts';

/**
 * AI NL→Smart View (task 3g). §I-AI / ARCHITECTURE §7: the model's DSL is RE-PARSED
 * by the shared parser; invalid DSL is a visible error, never a silent guess, and no
 * view is saved here. The suite pins valid→AST, invalid→error-with-position, and the
 * catalog-gating (an out-of-catalog custom field is a parse error, not accepted).
 */

const CATALOG = { builtins: ['status', 'name', 'last_contacted', 'dnc'], custom: [] };

describe('nlToSmartView', () => {
  test('valid DSL round-trips to a typed AST', async () => {
    const ai = createMockAIProvider();
    const result = await nlToSmartView({ ai }, { query: 'all won deals', catalog: CATALOG });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(astToDsl(result.ast)).toBe('status = "Won"');
    }
  });

  test('invalid DSL surfaces a visible, position-carrying error (no guess)', async () => {
    const ai = createMockAIProvider();
    ai.scriptSmartView('gibberish', 'status = = broken >< nonsense');
    const result = await nlToSmartView({ ai }, { query: 'gibberish', catalog: CATALOG });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rawDsl).toBe('status = = broken >< nonsense');
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.position).toBeDefined();
    }
  });

  test('an out-of-catalog custom field is a parse error, not an accepted guess', async () => {
    const ai = createMockAIProvider();
    ai.scriptSmartView('by tier', 'custom.tier = "gold"');
    // Catalog has NO custom fields → custom.tier is unknown → parse error.
    const result = await nlToSmartView({ ai }, { query: 'by tier', catalog: CATALOG });
    expect(result.ok).toBe(false);
  });

  test('a custom field IN the catalog parses successfully', async () => {
    const ai = createMockAIProvider();
    ai.scriptSmartView('by tier', 'custom.tier = "gold"');
    const result = await nlToSmartView(
      { ai },
      {
        query: 'by tier',
        catalog: { builtins: ['status'], custom: [{ key: 'tier', type: 'select' }] },
      },
    );
    expect(result.ok).toBe(true);
  });

  test('empty query → NlToSmartViewError (failure path)', async () => {
    const ai = createMockAIProvider();
    await expect(nlToSmartView({ ai }, { query: '  ', catalog: CATALOG })).rejects.toBeInstanceOf(
      NlToSmartViewError,
    );
  });
});
