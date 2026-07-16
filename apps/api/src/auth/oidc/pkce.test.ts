import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { base64UrlEncode } from '../encoding.ts';
import { createPkce, randomToken } from './pkce.ts';

/** Task 5a — PKCE derivation + CSPRNG token properties. */

describe('createPkce', () => {
  test('challenge is base64url(sha256(verifier)) with method S256', () => {
    const pkce = createPkce();
    expect(pkce.method).toBe('S256');
    const expected = base64UrlEncode(createHash('sha256').update(pkce.verifier).digest());
    expect(pkce.challenge).toBe(expected);
  });

  test('verifier/challenge are URL-safe (no +/= padding)', () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('each call is unique', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
  });
});

describe('randomToken', () => {
  test('is unique per call and non-trivial length', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
  });
});
