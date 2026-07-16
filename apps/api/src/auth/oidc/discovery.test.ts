import { describe, expect, test } from 'vitest';

import { DiscoveryCache, DiscoveryError, discoveryUrl } from './discovery.ts';
import type { HttpTransport } from './transport.ts';
import { LocalOidcIssuer } from '../testing/local-oidc-issuer.ts';

/** Task 5a — discovery-document fetch, validation, issuer-match, and caching. */

interface Counting {
  transport: HttpTransport;
  getCount: () => number;
}

function counting(inner: HttpTransport): Counting {
  let n = 0;
  return {
    getCount: () => n,
    transport: {
      getJson: (url) => {
        n += 1;
        return inner.getJson(url);
      },
      postForm: (url, body) => inner.postForm(url, body),
    },
  };
}

describe('discovery', () => {
  test('resolves + validates the document', async () => {
    const issuer = new LocalOidcIssuer();
    const cache = new DiscoveryCache(issuer.issuer, { transport: issuer.transport() });
    const doc = await cache.get();
    expect(doc.token_endpoint).toBe(issuer.tokenEndpoint);
    expect(doc.jwks_uri).toBe(issuer.jwksUri);
  });

  test('discoveryUrl tolerates a trailing slash', () => {
    expect(discoveryUrl('https://idp.test/')).toBe(
      'https://idp.test/.well-known/openid-configuration',
    );
  });

  test('caches — a second get() does not refetch', async () => {
    const issuer = new LocalOidcIssuer();
    const c = counting(issuer.transport());
    const cache = new DiscoveryCache(issuer.issuer, { transport: c.transport });
    await cache.get();
    await cache.get();
    expect(c.getCount()).toBe(1);
  });

  test('issuer mismatch is rejected', async () => {
    const issuer = new LocalOidcIssuer({ issuer: 'https://real.test' });
    // Configure the cache for a different issuer than the document advertises.
    const cache = new DiscoveryCache('https://spoof.test', {
      transport: {
        getJson: async () => issuer.discoveryDocument(),
        postForm: async () => ({}),
      },
    });
    await expect(cache.get()).rejects.toBeInstanceOf(DiscoveryError);
  });

  test('a malformed document is rejected', async () => {
    const cache = new DiscoveryCache('https://idp.test', {
      transport: {
        getJson: async () => ({ issuer: 'https://idp.test' }), // missing endpoints
        postForm: async () => ({}),
      },
    });
    await expect(cache.get()).rejects.toBeInstanceOf(DiscoveryError);
  });
});
