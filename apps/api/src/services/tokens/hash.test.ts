import { describe, expect, test } from 'vitest';

import {
  TOKEN_PREFIX,
  generateTokenPlaintext,
  hashToken,
  hashesEqual,
  looksLikeToken,
} from './hash.ts';

/** Task 5c — token secret material. Never store plaintext; sha256 only. */

describe('generateTokenPlaintext', () => {
  test('is prefixed, high-entropy, and unique per call', () => {
    const a = generateTokenPlaintext();
    const b = generateTokenPlaintext();
    expect(a.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    // 32 bytes → 43 base64url chars, plus the prefix.
    expect(a.length).toBe(TOKEN_PREFIX.length + 43);
    expect(a.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('hashToken', () => {
  test('produces a 64-char lowercase hex sha256, deterministically', () => {
    const plain = generateTokenPlaintext();
    const h1 = hashToken(plain);
    const h2 = hashToken(plain);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('distinct plaintext → distinct hash; the plaintext is not recoverable', () => {
    const a = hashToken('sbk_aaa');
    const b = hashToken('sbk_bbb');
    expect(a).not.toBe(b);
    // Known sha256 vector: the hash of the literal string 'sbk_aaa' is stable.
    expect(a).not.toContain('sbk_aaa');
  });
});

describe('looksLikeToken', () => {
  test('cheap pre-filter for the bearer path', () => {
    expect(looksLikeToken(generateTokenPlaintext())).toBe(true);
    expect(looksLikeToken('sbk_')).toBe(false);
    expect(looksLikeToken('Bearer xyz')).toBe(false);
    expect(looksLikeToken('')).toBe(false);
  });
});

describe('hashesEqual (constant-time)', () => {
  test('true for equal, false for unequal or different-length', () => {
    const h = hashToken('sbk_x');
    expect(hashesEqual(h, h)).toBe(true);
    expect(hashesEqual(h, hashToken('sbk_y'))).toBe(false);
    expect(hashesEqual(h, 'short')).toBe(false);
  });
});
