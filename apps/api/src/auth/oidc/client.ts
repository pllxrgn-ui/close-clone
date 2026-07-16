import { z } from 'zod';

import { constantTimeEqual } from '../encoding.ts';
import { DiscoveryCache } from './discovery.ts';
import { JwksCache } from './jwks.ts';
import { verifyIdToken, type IdTokenClaims } from './id-token.ts';
import { createPkce, randomToken } from './pkce.ts';
import { createFetchTransport, type HttpTransport } from './transport.ts';

/**
 * OIDC authorization-code + PKCE client (Task 5a). Orchestrates the two halves of
 * an interactive login against a generic OIDC issuer (Google Workspace by default):
 *
 *  - {@link OidcClient.beginLogin} builds the authorization-endpoint URL and returns
 *    the per-login secrets (state, nonce, PKCE verifier) the caller must stash
 *    (Switchboard puts them in a short-lived signed cookie — see session/txn-cookie).
 *  - {@link OidcClient.completeLogin} validates the returned `state`, exchanges the
 *    code at the token endpoint (PKCE verifier attached), and verifies the ID
 *    token's signature + claims + nonce.
 *
 * All network I/O goes through the injected {@link HttpTransport}, so the whole
 * flow runs offline in tests against {@link import('../testing/local-oidc-issuer.ts').LocalOidcIssuer}.
 */

export const DEFAULT_SCOPES = ['openid', 'email', 'profile'] as const;

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  transport?: HttpTransport;
  now?: () => Date;
  clockSkewSec?: number;
}

export interface LoginRequest {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** The per-login secrets the caller stashed at {@link OidcClient.beginLogin}. */
export interface ExpectedLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface CompleteLoginParams {
  code: string;
  /** The `state` the IdP echoed back on the callback. */
  returnedState: string;
  expected: ExpectedLogin;
  redirectUri: string;
}

export interface CompleteLoginResult {
  claims: IdTokenClaims;
  idToken: string;
}

export class OidcStateMismatchError extends Error {
  constructor() {
    super('OIDC state mismatch');
    this.name = 'OidcStateMismatchError';
  }
}

export class OidcTokenResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcTokenResponseError';
  }
}

const tokenResponseSchema = z
  .object({
    id_token: z.string().min(1),
    token_type: z.string().optional(),
    access_token: z.string().optional(),
    expires_in: z.number().optional(),
  })
  .passthrough();

export class OidcClient {
  private readonly config: OidcClientConfig;
  private readonly transport: HttpTransport;
  private readonly now: () => Date;
  private readonly scopes: string[];
  private readonly discovery: DiscoveryCache;
  private jwksCache: { uri: string; cache: JwksCache } | null = null;

  constructor(config: OidcClientConfig) {
    this.config = config;
    this.transport = config.transport ?? createFetchTransport();
    this.now = config.now ?? (() => new Date());
    this.scopes = config.scopes ?? [...DEFAULT_SCOPES];
    this.discovery = new DiscoveryCache(config.issuer, {
      transport: this.transport,
      now: this.now,
    });
  }

  private jwksFor(uri: string): JwksCache {
    if (this.jwksCache !== null && this.jwksCache.uri === uri) return this.jwksCache.cache;
    const cache = new JwksCache(uri, { transport: this.transport, now: this.now });
    this.jwksCache = { uri, cache };
    return cache;
  }

  /** Build the authorization-endpoint redirect + the secrets to stash. */
  async beginLogin(redirectUri: string): Promise<LoginRequest> {
    const doc = await this.discovery.get();
    const state = randomToken();
    const nonce = randomToken();
    const pkce = createPkce();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', this.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);
    return { authorizationUrl: url.toString(), state, nonce, codeVerifier: pkce.verifier };
  }

  /** Validate state, exchange the code (PKCE), and verify the ID token. */
  async completeLogin(params: CompleteLoginParams): Promise<CompleteLoginResult> {
    // State first — a login CSRF attempt should never reach the token endpoint.
    if (!constantTimeEqual(params.returnedState, params.expected.state)) {
      throw new OidcStateMismatchError();
    }
    const doc = await this.discovery.get();

    const raw = await this.transport.postForm(doc.token_endpoint, {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: params.expected.codeVerifier,
    });
    const parsed = tokenResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new OidcTokenResponseError(`invalid token response: ${parsed.error.message}`);
    }

    const claims = await verifyIdToken({
      token: parsed.data.id_token,
      issuer: doc.issuer,
      audience: this.config.clientId,
      nonce: params.expected.nonce,
      jwks: this.jwksFor(doc.jwks_uri),
      now: this.now,
      ...(this.config.clockSkewSec !== undefined ? { clockSkewSec: this.config.clockSkewSec } : {}),
    });

    return { claims, idToken: parsed.data.id_token };
  }
}
