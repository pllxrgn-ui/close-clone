import { describe, expect, test } from 'vitest';

import { parseCookies, serializeCookie, signValue, verifyValue } from './cookies.ts';

/** Task 5a — cookie serde + HMAC-signed payload primitives. */

describe('serializeCookie', () => {
  test('emits HttpOnly + Secure + SameSite=Lax by default', () => {
    const c = serializeCookie('sb_session', 'abc', { maxAgeSeconds: 60 });
    expect(c).toBe('sb_session=abc; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
  });
  test('secure can be disabled (local http dev)', () => {
    const c = serializeCookie('x', 'y', { secure: false });
    expect(c).not.toContain('Secure');
  });
});

describe('parseCookies', () => {
  test('parses multiple cookies and trims', () => {
    const m = parseCookies('a=1; b=2;  c=3');
    expect(m.get('a')).toBe('1');
    expect(m.get('b')).toBe('2');
    expect(m.get('c')).toBe('3');
  });
  test('undefined header → empty map', () => {
    expect(parseCookies(undefined).size).toBe(0);
  });
});

describe('signValue / verifyValue', () => {
  const secret = 'test-secret';

  test('round-trips a payload', () => {
    const token = signValue({ sub: 'u1', n: 3 }, secret);
    expect(verifyValue(token, secret)).toEqual({ sub: 'u1', n: 3 });
  });

  test('a tampered payload body fails the tag check → null', () => {
    const token = signValue({ sub: 'u1' }, secret);
    const [body, tag] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
    expect(verifyValue(`${forgedBody}.${tag}`, secret)).toBeNull();
    expect(body).toBeTruthy();
  });

  test('a wrong secret fails → null', () => {
    const token = signValue({ sub: 'u1' }, secret);
    expect(verifyValue(token, 'other-secret')).toBeNull();
  });

  test('a structurally invalid token → null', () => {
    expect(verifyValue('nodot', secret)).toBeNull();
    expect(verifyValue('.onlytag', secret)).toBeNull();
  });
});
