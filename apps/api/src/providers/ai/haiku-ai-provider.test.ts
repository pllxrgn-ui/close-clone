import { describe, expect, test } from 'vitest';
import {
  AIRefusalError,
  AnthropicApiError,
  createHaikuAIProvider,
  type AnthropicTransport,
  type AnthropicTransportRequest,
  type AnthropicTransportResponse,
} from './haiku-ai-provider.ts';

/**
 * Real Haiku adapter (tasks 3e/3g) exercised ONLY through a synthetic transport with
 * RECORDED Messages-API responses — no network, no Anthropic account (parity with
 * 2b/3b). Asserts request shape (model=claude-haiku-4-5, api-key header, structured
 * output on summarize/draft, none on smart-view) and the parse/refusal/error paths.
 */

function stub(response: AnthropicTransportResponse): {
  transport: AnthropicTransport;
  requests: AnthropicTransportRequest[];
} {
  const requests: AnthropicTransportRequest[] = [];
  return {
    requests,
    transport: {
      async request(req) {
        requests.push(req);
        return response;
      },
    },
  };
}

function textResponse(text: string, stopReason = 'end_turn'): AnthropicTransportResponse {
  return {
    status: 200,
    body: JSON.stringify({ stop_reason: stopReason, content: [{ type: 'text', text }] }),
  };
}

const TRANSCRIPT = { text: 'Customer wants a quote by Friday.', segments: [] };

describe('HaikuAIProvider.summarizeCall', () => {
  test('parses structured JSON output and validates it', async () => {
    const { transport, requests } = stub(
      textResponse(JSON.stringify({ summary: 'They want a quote.', actionItems: ['Send quote'] })),
    );
    const ai = createHaikuAIProvider({ apiKey: 'sk-test', transport });
    const out = await ai.summarizeCall(TRANSCRIPT, { leadName: 'Acme', direction: 'outbound' });
    expect(out).toEqual({ summary: 'They want a quote.', actionItems: ['Send quote'] });

    // Request shape: Haiku 4.5 model, api-key header, structured output requested.
    const body = JSON.parse(requests[0]?.body ?? '{}');
    expect(body.model).toBe('claude-haiku-4-5');
    expect(requests[0]?.headers['x-api-key']).toBe('sk-test');
    expect(requests[0]?.url).toContain('/v1/messages');
    expect(body.output_config.format.type).toBe('json_schema');
    // No thinking/effort params (they 400 on Haiku 4.5).
    expect(body.thinking).toBeUndefined();
    // Context is the minimum: only the label context reaches the prompt.
    expect(body.messages[0].content).toContain('Acme');
  });

  test('refusal stop_reason throws AIRefusalError', async () => {
    const { transport } = stub(textResponse('', 'refusal'));
    const ai = createHaikuAIProvider({ apiKey: 'k', transport });
    await expect(ai.summarizeCall(TRANSCRIPT, {})).rejects.toBeInstanceOf(AIRefusalError);
  });

  test('non-2xx throws AnthropicApiError', async () => {
    const { transport } = stub({ status: 500, body: 'err' });
    const ai = createHaikuAIProvider({ apiKey: 'k', transport });
    await expect(ai.summarizeCall(TRANSCRIPT, {})).rejects.toBeInstanceOf(AnthropicApiError);
  });

  test('non-JSON structured output throws AnthropicApiError', async () => {
    const { transport } = stub(textResponse('not json'));
    const ai = createHaikuAIProvider({ apiKey: 'k', transport });
    await expect(ai.summarizeCall(TRANSCRIPT, {})).rejects.toBeInstanceOf(AnthropicApiError);
  });
});

describe('HaikuAIProvider.draftEmail', () => {
  test('parses draft JSON; omits absent subject', async () => {
    const { transport } = stub(textResponse(JSON.stringify({ body: 'Hi there' })));
    const ai = createHaikuAIProvider({ apiKey: 'k', transport });
    const draft = await ai.draftEmail('Ask for renewal', { recentMessages: [] });
    expect(draft).toEqual({ body: 'Hi there' });
    expect('subject' in draft).toBe(false);
  });

  test('empty instruction throws before any request', async () => {
    const { transport, requests } = stub(textResponse('{}'));
    const ai = createHaikuAIProvider({ apiKey: 'k', transport });
    await expect(ai.draftEmail('', {})).rejects.toThrow(/empty instruction/);
    expect(requests).toHaveLength(0);
  });
});

describe('HaikuAIProvider.nlToSmartView', () => {
  test('returns the raw DSL text verbatim, no structured output', async () => {
    const { transport, requests } = stub(textResponse('  no email within 30d  '));
    const ai = createHaikuAIProvider({ apiKey: 'k', transport });
    const out = await ai.nlToSmartView('no emails in 30 days', {
      builtins: ['status'],
      custom: [{ key: 'tier', type: 'select' }],
    });
    expect(out.dsl).toBe('no email within 30d'); // trimmed, not parsed by the adapter
    const body = JSON.parse(requests[0]?.body ?? '{}');
    expect(body.output_config).toBeUndefined(); // DSL is free text, re-parsed by the feature
    expect(body.messages[0].content).toContain('custom.<key>');
  });

  test('empty query throws', async () => {
    const { transport } = stub(textResponse('x'));
    const ai = createHaikuAIProvider({ apiKey: 'k', transport });
    await expect(ai.nlToSmartView('', { builtins: [], custom: [] })).rejects.toThrow(/empty query/);
  });
});
