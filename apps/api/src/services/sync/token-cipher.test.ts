import { describe, expect, test } from 'vitest';
import type { OAuthTokens } from '@switchboard/shared/providers';
import { TokenCipher, TokenDecryptError } from './token-cipher.ts';

/**
 * OAuth token encryption at rest (CONTRACTS §C1 `email_accounts.oauth_tokens`
 * "encrypted"). Round-trip fidelity + the failure paths that must NOT yield a
 * partial/forged token: tamper, wrong key, malformed blob.
 */

const TOKENS: OAuthTokens = {
  accessToken: 'ya29.access-token',
  refreshToken: '1//refresh-token',
  expiresAt: '2026-01-01T01:00:00.000Z',
  scope: 'https://www.googleapis.com/auth/gmail.modify',
  tokenType: 'Bearer',
};

describe('TokenCipher round-trip', () => {
  test('encrypts to an opaque v1 blob and decrypts back to the exact tokens', () => {
    const cipher = new TokenCipher('unit-secret');
    const blob = cipher.encrypt(TOKENS);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob).not.toContain('ya29.access-token');
    expect(cipher.decrypt(blob)).toEqual(TOKENS);
  });

  test('two encryptions of the same tokens differ (random IV) but both decrypt', () => {
    const cipher = new TokenCipher('unit-secret');
    const a = cipher.encrypt(TOKENS);
    const b = cipher.encrypt(TOKENS);
    expect(a).not.toEqual(b);
    expect(cipher.decrypt(a)).toEqual(TOKENS);
    expect(cipher.decrypt(b)).toEqual(TOKENS);
  });
});

describe('TokenCipher failure paths', () => {
  test('a different key cannot decrypt (GCM tag mismatch)', () => {
    const blob = new TokenCipher('secret-a').encrypt(TOKENS);
    expect(() => new TokenCipher('secret-b').decrypt(blob)).toThrow(TokenDecryptError);
  });

  test('a tampered ciphertext is rejected, never partially decrypted', () => {
    const cipher = new TokenCipher('unit-secret');
    const blob = cipher.encrypt(TOKENS);
    const parts = blob.split('.');
    // Flip a character in the ciphertext segment.
    const ct = parts[3]!;
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    const tampered = [parts[0], parts[1], parts[2], flipped].join('.');
    expect(() => cipher.decrypt(tampered)).toThrow(TokenDecryptError);
  });

  test('a malformed blob (wrong segment count / version) is rejected', () => {
    const cipher = new TokenCipher('unit-secret');
    expect(() => cipher.decrypt('not-a-blob')).toThrow(TokenDecryptError);
    expect(() => cipher.decrypt('v2.a.b.c')).toThrow(TokenDecryptError);
  });

  test('an empty secret is rejected at construction', () => {
    expect(() => new TokenCipher('')).toThrow();
  });
});
