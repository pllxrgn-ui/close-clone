import { describe, expect, test } from 'vitest';

import { REDACTED } from './redaction.ts';
import {
  REQUEST_ID_HEADER,
  buildLoggerOptions,
  classifyErrorCode,
  errSerializer,
  genRequestId,
  reqSerializer,
  resSerializer,
  statusToErrorCode,
} from './logging.ts';

/**
 * Task 5e — pino logging config. Proves the request-id in/out contract source,
 * the redacting serializers (a bearer token must never survive serialization),
 * and the C8 error-code tagging used by the http-observability plugin.
 */

describe('genRequestId', () => {
  test('propagates a well-formed incoming x-request-id', () => {
    expect(genRequestId({ headers: { [REQUEST_ID_HEADER]: 'req-abc-123' } })).toBe('req-abc-123');
  });

  test('generates a fresh id when the header is absent', () => {
    const id = genRequestId({ headers: {} });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('rejects an id with control characters (log-injection guard) and generates one', () => {
    const id = genRequestId({ headers: { [REQUEST_ID_HEADER]: 'evil\ninjected line' } });
    expect(id).not.toContain('\n');
    expect(id).not.toBe('evil\ninjected line');
  });

  test('rejects an absurdly long id', () => {
    const id = genRequestId({ headers: { [REQUEST_ID_HEADER]: 'x'.repeat(5000) } });
    expect(id.length).toBeLessThan(100);
  });

  test('takes the first value when the header arrives as an array', () => {
    expect(genRequestId({ headers: { [REQUEST_ID_HEADER]: ['first', 'second'] } })).toBe('first');
  });
});

describe('reqSerializer', () => {
  test('redacts sensitive headers while keeping method/url/id', () => {
    const out = reqSerializer({
      id: 'r1',
      method: 'POST',
      url: '/api/v1/emails/send',
      ip: '10.0.0.1',
      headers: {
        authorization: 'Bearer secret-token-xyz',
        cookie: 'sid=abcd',
        'content-type': 'application/json',
      },
    });
    expect(out.method).toBe('POST');
    expect(out.url).toBe('/api/v1/emails/send');
    expect(out.id).toBe('r1');
    expect(out.remoteAddress).toBe('10.0.0.1');
    const headers = out.headers as Record<string, unknown>;
    expect(headers['authorization']).toBe(REDACTED);
    expect(headers['cookie']).toBe(REDACTED);
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.stringify(out)).not.toContain('secret-token-xyz');
  });
});

describe('resSerializer', () => {
  test('serializes only the status code', () => {
    expect(resSerializer({ statusCode: 204 })).toEqual({ statusCode: 204 });
  });
});

describe('errSerializer', () => {
  test('tags the C8 code and never spreads unknown error properties', () => {
    const out = errSerializer({
      name: 'ConflictError',
      message: 'dupe',
      stack: 'ConflictError: dupe\n  at x',
      code: 'CONFLICT',
      // a stray secret hanging off the error must not leak
      authorization: 'Bearer leak',
    } as unknown as Parameters<typeof errSerializer>[0]);
    expect(out.type).toBe('ConflictError');
    expect(out.message).toBe('dupe');
    expect(out.code).toBe('CONFLICT');
    expect(JSON.stringify(out)).not.toContain('Bearer leak');
  });
});

describe('classifyErrorCode', () => {
  test('honors an explicit C8 code', () => {
    expect(classifyErrorCode({ code: 'SUPPRESSED' })).toBe('SUPPRESSED');
    expect(classifyErrorCode({ code: 'SYNC_REAUTH_REQUIRED' })).toBe('SYNC_REAUTH_REQUIRED');
  });

  test('maps zod + fastify validation errors to VALIDATION_FAILED', () => {
    expect(classifyErrorCode({ name: 'ZodError' })).toBe('VALIDATION_FAILED');
    expect(classifyErrorCode({ validation: [{ message: 'bad' }] })).toBe('VALIDATION_FAILED');
    expect(classifyErrorCode({ code: 'FST_ERR_VALIDATION', statusCode: 400 })).toBe(
      'VALIDATION_FAILED',
    );
  });

  test('falls back to status code, then INTERNAL', () => {
    expect(classifyErrorCode({ statusCode: 404 })).toBe('NOT_FOUND');
    expect(classifyErrorCode({ statusCode: 401 })).toBe('UNAUTHENTICATED');
    expect(classifyErrorCode(new Error('boom'))).toBe('INTERNAL');
    expect(classifyErrorCode('not even an error')).toBe('INTERNAL');
    expect(classifyErrorCode(null)).toBe('INTERNAL');
  });

  test('ignores a bogus code that is not part of the C8 taxonomy', () => {
    expect(classifyErrorCode({ code: 'NOT_A_REAL_CODE' })).toBe('INTERNAL');
  });
});

describe('statusToErrorCode', () => {
  test.each([
    [400, 'VALIDATION_FAILED'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
    [502, 'PROVIDER_ERROR'],
    [500, 'INTERNAL'],
    [418, 'INTERNAL'],
  ] as const)('maps %i → %s', (status, code) => {
    expect(statusToErrorCode(status)).toBe(code);
  });
});

describe('buildLoggerOptions', () => {
  test('defaults level to info and wires redacting serializers + redact paths', () => {
    const opts = buildLoggerOptions();
    expect(opts.level).toBe('info');
    expect(typeof opts.serializers.req).toBe('function');
    expect(typeof opts.serializers.res).toBe('function');
    expect(typeof opts.serializers.err).toBe('function');
    expect(opts.redact.censor).toBe(REDACTED);
    expect(opts.redact.paths).toContain('req.headers.authorization');
    expect(opts.redact.paths).toContain('authorization');
  });

  test('respects an injected level and stream', () => {
    const lines: string[] = [];
    const opts = buildLoggerOptions({ level: 'debug', stream: { write: (m) => lines.push(m) } });
    expect(opts.level).toBe('debug');
    expect(opts.stream).toBeDefined();
  });
});
