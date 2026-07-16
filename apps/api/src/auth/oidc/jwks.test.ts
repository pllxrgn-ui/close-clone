import { describe, expect, test } from 'vitest';

import { JwksCache, JwksKeyNotFoundError } from './jwks.ts';
import type { HttpTransport } from './transport.ts';
import { LocalOidcIssuer } from '../testing/local-oidc-issuer.ts';

/** Task 5a — JWKS cache: key resolution, rotation, anti-DoS refetch floor, TTL. */

function counting(inner: HttpTransport): { transport: HttpTransport; count: () => number } {
  let n = 0;
  return {
    count: () => n,
    transport: {
      getJson: (url) => {
        n += 1;
        return inner.getJson(url);
      },
      postForm: (url, b) => inner.postForm(url, b),
    },
  };
}

describe('JwksCache', () => {
  test('resolves a published key and caches it', async () => {
    const issuer = new LocalOidcIssuer();
    const c = counting(issuer.transport());
    const cache = new JwksCache(issuer.jwksUri, { transport: c.transport });
    const k1 = await cache.getKey('key-1');
    expect(k1.asymmetricKeyType).toBe('rsa');
    await cache.getKey('key-1');
    expect(c.count()).toBe(1); // second hit served from cache
  });

  test('unknown kid refetches once then fails closed', async () => {
    const issuer = new LocalOidcIssuer();
    const c = counting(issuer.transport());
    const cache = new JwksCache(issuer.jwksUri, { transport: c.transport, minRefetchMs: 0 });
    await cache.getKey('key-1'); // fetch #1
    await expect(cache.getKey('nope')).rejects.toBeInstanceOf(JwksKeyNotFoundError);
    expect(c.count()).toBe(2); // one refetch attempt for the miss
  });

  test('picks up a rotated-in key on refetch', async () => {
    const issuer = new LocalOidcIssuer();
    const cache = new JwksCache(issuer.jwksUri, { transport: issuer.transport(), minRefetchMs: 0 });
    await cache.getKey('key-1');
    issuer.rotateKey('key-2', { keepPrevious: true });
    const k2 = await cache.getKey('key-2');
    expect(k2.asymmetricKeyType).toBe('rsa');
  });

  test('anti-DoS: within minRefetchMs, a repeated unknown kid does not refetch', async () => {
    const issuer = new LocalOidcIssuer();
    const c = counting(issuer.transport());
    // Frozen clock → elapsed is always 0 < minRefetchMs, so the floor holds.
    const cache = new JwksCache(issuer.jwksUri, {
      transport: c.transport,
      now: () => new Date(1_000_000),
      minRefetchMs: 60_000,
    });
    await cache.getKey('key-1'); // fetch #1 (primes cache, fresh)
    await expect(cache.getKey('ghost')).rejects.toBeInstanceOf(JwksKeyNotFoundError);
    await expect(cache.getKey('ghost')).rejects.toBeInstanceOf(JwksKeyNotFoundError);
    expect(c.count()).toBe(1); // floor prevented refetch storms
  });

  test('TTL expiry forces a proactive refetch', async () => {
    const issuer = new LocalOidcIssuer();
    const c = counting(issuer.transport());
    let t = 1_000_000;
    const cache = new JwksCache(issuer.jwksUri, {
      transport: c.transport,
      now: () => new Date(t),
      ttlMs: 1000,
      minRefetchMs: 0,
    });
    await cache.getKey('key-1'); // fetch #1
    t += 2000; // exceed ttl
    await cache.getKey('key-1'); // stale → fetch #2
    expect(c.count()).toBe(2);
  });
});
