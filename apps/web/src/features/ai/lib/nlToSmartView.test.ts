import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
  astToDsl,
  BUILTIN_FIELD_NAMES,
  parse,
  type SmartViewFieldCatalog,
} from '@switchboard/shared';
import { server } from '../../../mocks/server.ts';
import { ApiError } from '../../../api/errors.ts';
import { requestNlSmartView } from './nlToSmartView.ts';

/*
 * The client-side authority for NL→Smart View (§7 / §I-AI): the AI route returns
 * DSL TEXT, and the UI re-parses it with the SAME `parse()` the builder uses.
 * Invalid DSL becomes a visible, position-carrying error — never a silent guess.
 */

const api = (path: string): string => `*/api/v1${path}`;
const catalog: SmartViewFieldCatalog = { builtins: [...BUILTIN_FIELD_NAMES], custom: [] };

beforeEach(() => {
  document.documentElement.lang = 'en';
});
afterEach(() => server.resetHandlers());

describe('requestNlSmartView', () => {
  test('valid DSL: re-parses the AI text and returns the client-parsed AST', async () => {
    server.use(
      http.post(api('/ai/smart-view'), () =>
        // The server also returns an `ast`, but the UI re-derives its own from the
        // DSL text — the client parser is the authority, not the server payload.
        HttpResponse.json({ dsl: 'status = "Won"', ast: { bogus: true } }),
      ),
    );

    const result = await requestNlSmartView('show me won deals', catalog);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.dsl).toBe('status = "Won"');
    // The returned AST is the one the client parsed (round-trips to canonical DSL),
    // NOT the server's `{ bogus: true }`.
    expect(astToDsl(result.ast)).toBe(astToDsl(parse('status = "Won"')));
  });

  test('server VALIDATION_FAILED: surfaces the raw DSL + parse error + position', async () => {
    server.use(
      http.post(api('/ai/smart-view'), () =>
        HttpResponse.json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'AI produced invalid DSL',
              details: {
                rawDsl: 'status == "Won"',
                parseError: 'unexpected token "="',
                position: { line: 1, col: 9, offset: 8 },
              },
            },
          },
          { status: 400 },
        ),
      ),
    );

    const result = await requestNlSmartView('show me won deals', catalog);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.rawDsl).toBe('status == "Won"');
    expect(result.error).toContain('=');
    expect(result.position).toEqual({ line: 1, col: 9, offset: 8 });
  });

  test('client re-parse rejects an AI "success" that is actually invalid DSL', async () => {
    // Server claims success, but the DSL text does not parse under the shared
    // parser — the UI must NOT trust it (defense in depth), and instead surface it.
    server.use(
      http.post(api('/ai/smart-view'), () =>
        HttpResponse.json({ dsl: 'status =', ast: { fake: 'ast' } }),
      ),
    );

    const result = await requestNlSmartView('broken', catalog);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.rawDsl).toBe('status =');
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.position).toBeDefined();
  });

  test('non-validation errors (PROVIDER_ERROR) reject so the caller can surface them', async () => {
    server.use(
      http.post(api('/ai/smart-view'), () =>
        HttpResponse.json(
          { error: { code: 'PROVIDER_ERROR', message: 'the model declined' } },
          { status: 502 },
        ),
      ),
    );

    await expect(requestNlSmartView('anything', catalog)).rejects.toBeInstanceOf(ApiError);
  });
});
