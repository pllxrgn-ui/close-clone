import { describe, expect, test } from 'vitest';

import {
  OidcClient,
  OidcStateMismatchError,
  OidcTokenResponseError,
  type OidcClientConfig,
} from './client.ts';
import { IdTokenInvalidError } from './id-token.ts';
import type { HttpTransport } from './transport.ts';
import { LocalOidcIssuer } from '../testing/local-oidc-issuer.ts';

/**
 * Task 5a — OIDC client end-to-end against LocalOidcIssuer (no network). Proves
 * the happy path plus the "bad state" acceptance case and token-response guards.
 */

const CLIENT = 'switchboard-web';
const REDIRECT = 'https://app.switchboard.test/api/v1/auth/callback';
const now = (): Date => new Date(Date.parse('2026-07-15T12:00:00.000Z'));

function makeClient(
  issuer: LocalOidcIssuer,
  transport: HttpTransport = issuer.transport(),
): OidcClient {
  const config: OidcClientConfig = {
    issuer: issuer.issuer,
    clientId: CLIENT,
    clientSecret: 'shh',
    transport,
    now,
  };
  return new OidcClient(config);
}

describe('beginLogin', () => {
  test('builds a spec-compliant authorization URL', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const req = await makeClient(issuer).beginLogin(REDIRECT);
    const url = new URL(req.authorizationUrl);
    expect(url.origin + url.pathname).toBe(issuer.authorizationEndpoint);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(req.state);
    expect(url.searchParams.get('nonce')).toBe(req.nonce);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    // The verifier must never appear in the redirect.
    expect(req.authorizationUrl).not.toContain(req.codeVerifier);
  });
});

describe('completeLogin happy path', () => {
  test('exchanges the code and returns verified claims', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const client = makeClient(issuer);
    const req = await client.beginLogin(REDIRECT);
    const code = issuer.authorize({
      sub: 'google|42',
      nonce: req.nonce,
      email: 'rep@corp.test',
      name: 'Rep',
      groups: ['sales-crm-users'],
    });
    const { claims } = await client.completeLogin({
      code,
      returnedState: req.state,
      expected: req,
      redirectUri: REDIRECT,
    });
    expect(claims.sub).toBe('google|42');
    expect(claims.aud).toBe(CLIENT); // issuer bound aud to the presented client_id
    expect(claims.groups).toEqual(['sales-crm-users']);
  });
});

describe('failure paths', () => {
  test('bad state → OidcStateMismatchError, and the token endpoint is never called', async () => {
    const issuer = new LocalOidcIssuer({ now });
    let postCalls = 0;
    const transport: HttpTransport = {
      getJson: (u) => issuer.transport().getJson(u),
      postForm: (u, b) => {
        postCalls += 1;
        return issuer.transport().postForm(u, b);
      },
    };
    const client = makeClient(issuer, transport);
    const req = await client.beginLogin(REDIRECT);
    const code = issuer.authorize({ sub: 's', nonce: req.nonce });
    await expect(
      client.completeLogin({
        code,
        returnedState: 'forged-state',
        expected: req,
        redirectUri: REDIRECT,
      }),
    ).rejects.toBeInstanceOf(OidcStateMismatchError);
    expect(postCalls).toBe(0);
  });

  test('nonce mismatch (IdP token bound to a different nonce) → IdTokenInvalidError', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const client = makeClient(issuer);
    const req = await client.beginLogin(REDIRECT);
    const code = issuer.authorize({ sub: 's', nonce: 'not-the-expected-nonce' });
    await expect(
      client.completeLogin({
        code,
        returnedState: req.state,
        expected: req,
        redirectUri: REDIRECT,
      }),
    ).rejects.toBeInstanceOf(IdTokenInvalidError);
  });

  test('token response missing id_token → OidcTokenResponseError', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const transport: HttpTransport = {
      getJson: (u) => issuer.transport().getJson(u),
      postForm: async () => ({ token_type: 'Bearer' }), // no id_token
    };
    const client = makeClient(issuer, transport);
    const req = await client.beginLogin(REDIRECT);
    await expect(
      client.completeLogin({
        code: 'x',
        returnedState: req.state,
        expected: req,
        redirectUri: REDIRECT,
      }),
    ).rejects.toBeInstanceOf(OidcTokenResponseError);
  });

  test('a one-time code cannot be exchanged twice', async () => {
    const issuer = new LocalOidcIssuer({ now });
    const client = makeClient(issuer);
    const req = await client.beginLogin(REDIRECT);
    const code = issuer.authorize({ sub: 's', nonce: req.nonce });
    await client.completeLogin({
      code,
      returnedState: req.state,
      expected: req,
      redirectUri: REDIRECT,
    });
    await expect(
      client.completeLogin({
        code,
        returnedState: req.state,
        expected: req,
        redirectUri: REDIRECT,
      }),
    ).rejects.toBeTruthy(); // issuer rejects the reused code (invalid_grant)
  });
});
