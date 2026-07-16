import { describe, expect, test } from 'vitest';

import { REDACTED, isSensitiveField, redactDeep, redactHeaders } from './redaction.ts';

/**
 * Task 5e — the observability redaction classifier. This is the load-bearing
 * proof that credential material (Authorization/Cookie/token/secret) never
 * reaches a log line, an error-tracking payload, or an alert. Mirrors the
 * policy of `services/audit/redaction.ts` (over-redaction is acceptable; a leak
 * is not) but is tuned for HTTP header names and free-form log context and kept
 * self-contained so observability has no dependency on the audit service.
 */

describe('isSensitiveField', () => {
  test.each([
    'authorization',
    'Authorization',
    'AUTHORIZATION',
    'proxy-authorization',
    'cookie',
    'Cookie',
    'set-cookie',
    'Set-Cookie',
    'x-api-key',
    'x-auth-token',
    'x_session_secret',
    'refresh_token',
    'accessToken',
    'oauthTokens',
    'clientSecret',
    'password',
    'passphrase',
    'sessionSecret',
    'apiKey',
  ])('flags %s as sensitive', (name) => {
    expect(isSensitiveField(name)).toBe(true);
  });

  test.each([
    'content-type',
    'user-agent',
    'accept',
    'x-request-id',
    'host',
    'authorId', // must NOT be caught by an "auth"-prefix mistake
    'author',
    'name',
    'status',
    '',
  ])('leaves %s alone', (name) => {
    expect(isSensitiveField(name)).toBe(false);
  });
});

describe('redactHeaders', () => {
  test('censors sensitive header values but preserves key names and safe values', () => {
    const out = redactHeaders({
      authorization: 'Bearer super-secret-token-abc123',
      cookie: 'sid=deadbeef; theme=dark',
      'x-api-key': 'live_key_9f8e7d',
      'content-type': 'application/json',
      'user-agent': 'switchboard-test/1.0',
      'x-request-id': 'req-1234',
    });

    expect(out['authorization']).toBe(REDACTED);
    expect(out['cookie']).toBe(REDACTED);
    expect(out['x-api-key']).toBe(REDACTED);
    // Non-sensitive headers pass through untouched (logs stay useful).
    expect(out['content-type']).toBe('application/json');
    expect(out['user-agent']).toBe('switchboard-test/1.0');
    expect(out['x-request-id']).toBe('req-1234');
    // The key names remain visible so the log shows which headers were present.
    expect(Object.keys(out).sort()).toEqual(
      ['authorization', 'content-type', 'cookie', 'user-agent', 'x-api-key', 'x-request-id'].sort(),
    );
  });

  test('censors array-valued headers (e.g. multiple set-cookie)', () => {
    const out = redactHeaders({ 'set-cookie': ['a=1', 'b=2'], accept: ['text/html'] });
    expect(out['set-cookie']).toBe(REDACTED);
    expect(out['accept']).toEqual(['text/html']);
  });

  test('the raw secret substring never appears in the serialized output', () => {
    const secret = 'Bearer eyJhbGciOi.super.secret';
    const out = redactHeaders({ authorization: secret });
    expect(JSON.stringify(out)).not.toContain('super.secret');
  });

  test('does not mutate the input object', () => {
    const input = { authorization: 'Bearer x' };
    redactHeaders(input);
    expect(input.authorization).toBe('Bearer x');
  });

  test('handles undefined header values without throwing', () => {
    const out = redactHeaders({ authorization: undefined, accept: 'text/html' });
    expect(out['authorization']).toBe(REDACTED);
    expect(out['accept']).toBe('text/html');
  });
});

describe('redactDeep', () => {
  test('redacts sensitive keys at any nesting depth', () => {
    const out = redactDeep({
      user: 'alice',
      auth: { authorization: 'Bearer x', nested: { refreshToken: 'rt_1' } },
      list: [{ token: 't1' }, { safe: 'ok' }],
    }) as Record<string, unknown>;

    const auth = out['auth'] as Record<string, unknown>;
    expect(auth['authorization']).toBe(REDACTED);
    expect((auth['nested'] as Record<string, unknown>)['refreshToken']).toBe(REDACTED);
    const list = out['list'] as Array<Record<string, unknown>>;
    expect(list[0]?.['token']).toBe(REDACTED);
    expect(list[1]?.['safe']).toBe('ok');
    expect(out['user']).toBe('alice');
  });

  test('passes primitives through unchanged', () => {
    expect(redactDeep('hello')).toBe('hello');
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep(null)).toBe(null);
    expect(redactDeep(undefined)).toBe(undefined);
  });

  test('does not mutate the input', () => {
    const input = { secret: 'x', keep: 'y' };
    const out = redactDeep(input) as Record<string, unknown>;
    expect(input.secret).toBe('x');
    expect(out['secret']).toBe(REDACTED);
    expect(out['keep']).toBe('y');
  });

  test('caps runaway depth without throwing and never leaks a secret', () => {
    // Build a 40-deep chain that ends in a token; the depth cap must not let it slip.
    let node: Record<string, unknown> = { token: 'deep-secret' };
    for (let i = 0; i < 40; i += 1) node = { child: node };
    const out = redactDeep(node);
    expect(JSON.stringify(out)).not.toContain('deep-secret');
  });
});
