import { describe, expect, test } from 'vitest';

import { SESSION_COOKIE_NAME, SessionCodec } from './session.ts';

/** Task 5a — session cookie: round-trip, tamper, idle expiry, absolute cap, slide. */

const USER = '00000000-0000-4000-8000-00000000abcd';

/** Extract the `name=value` cookie pair from a Set-Cookie string as a Cookie header. */
function asRequestCookie(setCookie: string): string {
  return setCookie.split(';')[0] as string;
}

function codecAt(getMs: () => number, overrides: Record<string, number> = {}): SessionCodec {
  return new SessionCodec({
    secret: 'sess-secret',
    idleTtlSec: 100,
    absoluteTtlSec: 1000,
    renewAfterSec: 10,
    secure: false,
    now: () => new Date(getMs()),
    ...overrides,
  });
}

describe('issue + read', () => {
  test('a freshly issued cookie reads back the user id', () => {
    const ms = 1_000_000;
    const codec = codecAt(() => ms);
    const setCookie = codec.issue(USER);
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    const res = codec.read(asRequestCookie(setCookie));
    expect(res?.userId).toBe(USER);
  });

  test('no cookie → null', () => {
    const codec = codecAt(() => 1_000_000);
    expect(codec.read(undefined)).toBeNull();
    expect(codec.read('unrelated=1')).toBeNull();
  });
});

describe('tamper', () => {
  test('a mutated cookie value → null (guard maps to 401)', () => {
    const ms = 1_000_000;
    const codec = codecAt(() => ms);
    const setCookie = codec.issue(USER);
    const cookie = asRequestCookie(setCookie);
    const mutated = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
    expect(codec.read(mutated)).toBeNull();
  });

  test('a cookie signed with a different secret → null', () => {
    const ms = 1_000_000;
    const evil = new SessionCodec({ secret: 'evil', idleTtlSec: 100, now: () => new Date(ms) });
    const forged = asRequestCookie(evil.issue(USER));
    expect(codecAt(() => ms).read(forged)).toBeNull();
  });
});

describe('expiry', () => {
  test('idle timeout: past exp → null', () => {
    let ms = 1_000_000;
    const codec = codecAt(() => ms);
    const cookie = asRequestCookie(codec.issue(USER));
    ms += 101_000; // > idleTtl (100s)
    expect(codec.read(cookie)).toBeNull();
  });

  test('within idle window → valid', () => {
    let ms = 1_000_000;
    const codec = codecAt(() => ms);
    const cookie = asRequestCookie(codec.issue(USER));
    ms += 50_000; // < idleTtl
    expect(codec.read(cookie)?.userId).toBe(USER);
  });

  test('absolute cap: a continuously-refreshed session still dies at iat+absolute', () => {
    let ms = 1_000_000;
    const codec = codecAt(() => ms);
    let cookie = asRequestCookie(codec.issue(USER));
    // Walk forward in 50s steps, always re-adopting the refreshed cookie.
    for (let i = 0; i < 19; i += 1) {
      ms += 50_000;
      const res = codec.read(cookie);
      expect(res).not.toBeNull();
      if (res?.refreshedSetCookie) cookie = asRequestCookie(res.refreshedSetCookie);
    }
    // 20*50 = 1000s = absoluteTtl → dead, no matter the refreshes.
    ms += 50_000;
    expect(codec.read(cookie)).toBeNull();
  });
});

describe('sliding renewal', () => {
  test('past renewAfter, read refreshes the cookie with a later exp', () => {
    let ms = 1_000_000;
    const codec = codecAt(() => ms);
    const first = asRequestCookie(codec.issue(USER));
    ms += 20_000; // > renewAfter (10s)
    const res = codec.read(first);
    expect(res?.userId).toBe(USER);
    expect(res?.refreshedSetCookie).toBeDefined();
    // The refreshed cookie is itself valid and extends the window.
    const refreshed = asRequestCookie(res?.refreshedSetCookie as string);
    ms += 90_000; // 110s since original issue — original would be dead (idle 100s)
    expect(codec.read(refreshed)?.userId).toBe(USER);
  });

  test('before renewAfter, no refresh cookie is emitted', () => {
    let ms = 1_000_000;
    const codec = codecAt(() => ms);
    const cookie = asRequestCookie(codec.issue(USER));
    ms += 5_000; // < renewAfter
    const res = codec.read(cookie);
    expect(res?.userId).toBe(USER);
    expect(res?.refreshedSetCookie).toBeUndefined();
  });
});
