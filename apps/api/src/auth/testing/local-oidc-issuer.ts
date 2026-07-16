import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';

import { signCompactJws, type SupportedAlg } from '../oidc/jwt.ts';
import { discoveryUrl, type OidcDiscoveryDocument } from '../oidc/discovery.ts';
import { TransportError, type HttpTransport } from '../oidc/transport.ts';

/**
 * LocalOidcIssuer — a self-signing OIDC provider test double (Task 5a). It owns
 * real RSA keypairs and mints REAL, correctly-signed ID tokens, so the production
 * verifier is exercised end-to-end with no network and no external account
 * (CONTRACTS §C9). It exposes an {@link HttpTransport} that answers the discovery,
 * JWKS, and token-exchange calls the client makes, and models kid rotation (a key
 * published then rotated out) so the JWKS-miss / expired-kid paths are testable.
 *
 * This file lives under `auth/testing/` and is imported only by tests. It is not
 * on any production code path.
 */

interface KeyPair {
  kid: string;
  privateKey: KeyObject;
  publicJwk: JsonWebKey;
}

export interface IdTokenClaimsInput {
  sub: string;
  nonce?: string;
  email?: string;
  name?: string;
  groups?: string[];
  aud?: string | string[];
  iss?: string;
  iat?: number;
  exp?: number;
  /** Sign with a specific (possibly rotated-out) key; defaults to the active kid. */
  kid?: string;
  /** Override the header alg (to prove alg-confusion / unsupported-alg rejection). */
  alg?: SupportedAlg;
  /** Extra top-level claims. */
  extra?: Record<string, unknown>;
}

interface PendingCode {
  claims: IdTokenClaimsInput;
  used: boolean;
}

export interface LocalOidcIssuerOptions {
  issuer?: string;
  kid?: string;
  /** Default token lifetime (seconds) when a code/claims don't override exp. */
  defaultTtlSec?: number;
  now?: () => Date;
}

export class LocalOidcIssuer {
  readonly issuer: string;
  private readonly keys = new Map<string, KeyPair>();
  private readonly publishedKids = new Set<string>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly defaultTtlSec: number;
  private readonly now: () => Date;
  private activeKid: string;

  constructor(opts: LocalOidcIssuerOptions = {}) {
    this.issuer = (opts.issuer ?? 'https://idp.switchboard.test').replace(/\/+$/, '');
    this.defaultTtlSec = opts.defaultTtlSec ?? 3600;
    this.now = opts.now ?? (() => new Date());
    const kid = opts.kid ?? 'key-1';
    this.generate(kid, true);
    this.activeKid = kid;
  }

  // --- endpoints ------------------------------------------------------------

  get authorizationEndpoint(): string {
    return `${this.issuer}/authorize`;
  }
  get tokenEndpoint(): string {
    return `${this.issuer}/token`;
  }
  get jwksUri(): string {
    return `${this.issuer}/jwks`;
  }

  discoveryDocument(): OidcDiscoveryDocument {
    return {
      issuer: this.issuer,
      authorization_endpoint: this.authorizationEndpoint,
      token_endpoint: this.tokenEndpoint,
      jwks_uri: this.jwksUri,
    };
  }

  jwks(): { keys: JsonWebKey[] } {
    const keys: JsonWebKey[] = [];
    for (const kid of this.publishedKids) {
      const pair = this.keys.get(kid);
      if (pair !== undefined) keys.push(pair.publicJwk);
    }
    return { keys };
  }

  // --- key management -------------------------------------------------------

  private generate(kid: string, publish: boolean): void {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const publicJwk: JsonWebKey = { ...jwk, kid, alg: 'RS256', use: 'sig' };
    this.keys.set(kid, { kid, privateKey, publicJwk });
    if (publish) this.publishedKids.add(kid);
  }

  /**
   * Rotate the active signing key. By default the previous key is *unpublished*
   * from the JWKS (rotated out) — a token still bearing the old kid can no longer
   * be verified. Pass `keepPrevious` to publish both (a normal overlap window).
   */
  rotateKey(newKid: string, opts: { keepPrevious?: boolean } = {}): void {
    if (opts.keepPrevious !== true) this.publishedKids.clear();
    this.generate(newKid, true);
    this.activeKid = newKid;
  }

  // --- token minting --------------------------------------------------------

  /** Sign a real ID token from explicit claims (unit-test entry point). */
  signIdToken(input: IdTokenClaimsInput): string {
    const kid = input.kid ?? this.activeKid;
    const pair = this.keys.get(kid);
    if (pair === undefined) throw new Error(`LocalOidcIssuer: unknown signing kid '${kid}'`);
    const nowSec = Math.floor(this.now().getTime() / 1000);
    const payload: Record<string, unknown> = {
      iss: input.iss ?? this.issuer,
      sub: input.sub,
      aud: input.aud ?? 'test-client',
      iat: input.iat ?? nowSec,
      exp: input.exp ?? nowSec + this.defaultTtlSec,
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.groups !== undefined ? { groups: input.groups } : {}),
      ...(input.extra ?? {}),
    };
    return signCompactJws(
      { alg: input.alg ?? 'RS256', kid, typ: 'JWT' },
      payload,
      pair.privateKey,
      input.alg ?? 'RS256',
    );
  }

  /**
   * Simulate the user authenticating + consenting at the IdP: returns an opaque
   * one-time authorization `code`. The claims (and any adversarial overrides) are
   * bound to the code and realised when the client exchanges it at the token
   * endpoint. `aud` defaults to the client_id presented in the token request.
   */
  authorize(claims: IdTokenClaimsInput): string {
    const code = `code_${randomUUID()}`;
    this.codes.set(code, { claims, used: false });
    return code;
  }

  // --- transport double -----------------------------------------------------

  /** The {@link HttpTransport} the client uses in tests — no real network. */
  transport(): HttpTransport {
    return {
      getJson: async (url: string): Promise<unknown> => {
        if (url === discoveryUrl(this.issuer)) return this.discoveryDocument();
        if (url === this.jwksUri) return this.jwks();
        throw new TransportError(url, `LocalOidcIssuer: unexpected GET ${url}`, 404);
      },
      postForm: async (url: string, body: Record<string, string>): Promise<unknown> => {
        if (url !== this.tokenEndpoint) {
          throw new TransportError(url, `LocalOidcIssuer: unexpected POST ${url}`, 404);
        }
        return this.exchange(url, body);
      },
    };
  }

  private exchange(url: string, body: Record<string, string>): unknown {
    const code = body['code'];
    if (code === undefined) throw new TransportError(url, 'missing code', 400);
    const pending = this.codes.get(code);
    if (pending === undefined) throw new TransportError(url, 'invalid_grant: unknown code', 400);
    if (pending.used) throw new TransportError(url, 'invalid_grant: code already used', 400);
    pending.used = true;
    const clientId = body['client_id'];
    const idToken = this.signIdToken({
      ...pending.claims,
      ...(pending.claims.aud === undefined && clientId !== undefined ? { aud: clientId } : {}),
    });
    return {
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: this.defaultTtlSec,
      access_token: `at_${randomUUID()}`,
    };
  }
}
