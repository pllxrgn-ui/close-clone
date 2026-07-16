import { describe, expect, test } from 'vitest';

import { OIDC_TXN_COOKIE_NAME, OidcTxnCodec } from './txn.ts';

/** Task 5a — OIDC login-transaction cookie: round-trip, expiry, tamper, SameSite. */

function asRequestCookie(setCookie: string): string {
  return setCookie.split(';')[0] as string;
}

const txn = { state: 'st', nonce: 'no', codeVerifier: 'ver' };

describe('OidcTxnCodec', () => {
  test('round-trips the login secrets', () => {
    const ms = 1_000_000;
    const codec = new OidcTxnCodec({ secret: 's', now: () => new Date(ms) });
    const setCookie = codec.issue(txn);
    expect(setCookie).toContain(`${OIDC_TXN_COOKIE_NAME}=`);
    expect(setCookie).toContain('SameSite=Lax'); // required for the IdP redirect
    expect(codec.read(asRequestCookie(setCookie))).toEqual(txn);
  });

  test('expires after ttl', () => {
    let ms = 1_000_000;
    const codec = new OidcTxnCodec({ secret: 's', ttlSec: 60, now: () => new Date(ms) });
    const cookie = asRequestCookie(codec.issue(txn));
    ms += 61_000;
    expect(codec.read(cookie)).toBeNull();
  });

  test('tamper → null', () => {
    const codec = new OidcTxnCodec({ secret: 's' });
    const cookie = asRequestCookie(codec.issue(txn));
    expect(codec.read(cookie.slice(0, -1) + 'Z')).toBeNull();
  });

  test('clear emits a Max-Age=0 cookie', () => {
    const codec = new OidcTxnCodec({ secret: 's' });
    expect(codec.clear()).toContain('Max-Age=0');
  });
});
