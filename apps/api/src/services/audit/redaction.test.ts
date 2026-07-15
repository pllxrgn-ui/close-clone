import { describe, expect, test } from 'vitest';

import { isSensitiveKey, REDACTED, redactSnapshot } from './redaction.ts';

/**
 * Task 5b — snapshot redaction. The audit trail must never carry credential
 * material (OAuth tokens, api-token hashes, secrets). These tests pin the key
 * classifier and the recursive redactor, including the nested/array and
 * do-not-mutate paths.
 */

describe('isSensitiveKey', () => {
  const sensitive = [
    'oauth_tokens',
    'oauthTokens',
    'oauth_token',
    'access_token',
    'accessToken',
    'refresh_token',
    'refreshToken',
    'id_token',
    'googleAccessToken',
    'token',
    'tokens',
    'secret',
    'client_secret',
    'clientSecret',
    'session_secret',
    'password',
    'passphrase',
    'hash',
    'authorization',
    'apiKey',
    'api_key',
    'privateKey',
    'credentials',
  ];
  test.each(sensitive)('%s is sensitive', (k) => {
    expect(isSensitiveKey(k)).toBe(true);
  });

  const safe = [
    'name',
    'email',
    'role',
    'recordingEnabled',
    'value',
    'id',
    'entity',
    'reason',
    'ip',
  ];
  test.each(safe)('%s is not sensitive', (k) => {
    expect(isSensitiveKey(k)).toBe(false);
  });

  test('empty / punctuation-only keys are not sensitive', () => {
    expect(isSensitiveKey('')).toBe(false);
    expect(isSensitiveKey('___')).toBe(false);
  });
});

describe('redactSnapshot', () => {
  test('redacts a top-level oauth token value', () => {
    const out = redactSnapshot({ address: 'box@x.test', oauthTokens: 'ya29.SECRET' });
    expect(out).toEqual({ address: 'box@x.test', oauthTokens: REDACTED });
  });

  test('redacts an entire object under a sensitive key', () => {
    const out = redactSnapshot({
      provider: 'gmail',
      oauth_tokens: { access_token: 'a', refresh_token: 'b', expiresAt: 123 },
    });
    // The whole subtree is replaced, not walked into.
    expect(out).toEqual({ provider: 'gmail', oauth_tokens: REDACTED });
  });

  test('redacts sensitive keys nested in objects and arrays', () => {
    const out = redactSnapshot({
      user: { name: 'A', apiKey: 'k' },
      accounts: [
        { address: 'a@x', accessToken: 't1' },
        { address: 'b@x', accessToken: 't2' },
      ],
    });
    expect(out).toEqual({
      user: { name: 'A', apiKey: REDACTED },
      accounts: [
        { address: 'a@x', accessToken: REDACTED },
        { address: 'b@x', accessToken: REDACTED },
      ],
    });
  });

  test('preserves non-sensitive values including null and nested primitives', () => {
    const snap = {
      recordingEnabled: true,
      recordingEnabledBy: null,
      dailySendCap: 200,
      companyTimezone: 'UTC',
    };
    expect(redactSnapshot(snap)).toEqual(snap);
  });

  test('does not mutate the input object', () => {
    const input = { oauthTokens: 'secret', nested: { token: 'x' } };
    const snapshotOfInput = structuredClone(input);
    redactSnapshot(input);
    expect(input).toEqual(snapshotOfInput);
  });

  test('handles an empty object', () => {
    expect(redactSnapshot({})).toEqual({});
  });

  test('redacts case-insensitively and across separators', () => {
    const out = redactSnapshot({ OAuth_Tokens: 'x', 'Refresh-Token': 'y', ACCESSTOKEN: 'z' });
    expect(out).toEqual({
      OAuth_Tokens: REDACTED,
      'Refresh-Token': REDACTED,
      ACCESSTOKEN: REDACTED,
    });
  });
});
