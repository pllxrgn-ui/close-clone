import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';

import { base64UrlDecodeToString, base64UrlEncode } from '../encoding.ts';

/**
 * Compact JWS (RFC 7515) encode/decode + RSA signature verification, built on
 * `node:crypto` (Task 5a). This is the ID-token cryptography: no `jose`, no other
 * dependency. Only RSASSA-PKCS1-v1_5 (`RS256`/`RS384`/`RS512`) is accepted — the
 * algorithm allow-list is a security control, not a convenience:
 *
 *  - `none` is rejected (unsigned tokens must never verify).
 *  - HMAC algs (`HS*`) are rejected here so an attacker cannot swap an asymmetric
 *    token for a symmetric one signed with the (public) modulus — the classic JWKS
 *    algorithm-confusion attack. This module only ever verifies with a *public*
 *    key object, so an `HS256` header can never be honoured.
 *
 * Google Workspace (the default issuer) signs ID tokens with `RS256`, so RSA is
 * the whole surface v1 needs; EC/EdDSA support is a deliberate non-goal.
 */

/** RSA algs we accept, mapped to their `node:crypto` hash name. */
const RSA_ALG_TO_HASH: Readonly<Record<string, string>> = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
};

export type SupportedAlg = 'RS256' | 'RS384' | 'RS512';

export function isSupportedAlg(alg: string): alg is SupportedAlg {
  return Object.prototype.hasOwnProperty.call(RSA_ALG_TO_HASH, alg);
}

export interface JwsHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface DecodedJwt {
  header: JwsHeader;
  payload: Record<string, unknown>;
  /** The `base64url(header).base64url(payload)` bytes the signature covers. */
  signingInput: string;
  /** Raw signature bytes (base64url-decoded). */
  signature: Buffer;
}

export class JwtMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtMalformedError';
  }
}

function parseJsonObject(raw: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JwtMalformedError(`jwt ${what} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new JwtMalformedError(`jwt ${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Split + decode a compact JWS WITHOUT verifying the signature. Callers must not
 * trust the result until {@link verifyJwsSignature} succeeds. Throws
 * {@link JwtMalformedError} on a structurally invalid token.
 */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtMalformedError('compact JWS must have exactly three segments');
  }
  const [h, p, s] = parts as [string, string, string];
  if (h === '' || p === '' || s === '') {
    throw new JwtMalformedError('compact JWS has an empty segment');
  }
  const header = parseJsonObject(base64UrlDecodeToString(h), 'header') as JwsHeader &
    Record<string, unknown>;
  if (typeof header.alg !== 'string') {
    throw new JwtMalformedError('jwt header is missing a string `alg`');
  }
  const payload = parseJsonObject(base64UrlDecodeToString(p), 'payload');
  return {
    header,
    payload,
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

/** Import a public RSA JWK into a `node:crypto` KeyObject. */
export function importRsaJwk(jwk: JsonWebKey): KeyObject {
  if (jwk.kty !== 'RSA') {
    throw new JwtMalformedError(`unsupported JWK key type: ${String(jwk.kty)}`);
  }
  return createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Verify a decoded token's signature against a public key. Returns `false` for a
 * bad signature, an unsupported/again-confused alg, or any crypto error — never
 * throws for a verification failure (a thrown error would be indistinguishable
 * from "invalid" to callers, so we normalise to `false`).
 */
export function verifyJwsSignature(decoded: DecodedJwt, publicKey: KeyObject): boolean {
  const hash = RSA_ALG_TO_HASH[decoded.header.alg];
  if (hash === undefined) return false;
  if (publicKey.asymmetricKeyType !== 'rsa') return false;
  try {
    return cryptoVerify(
      hash,
      Buffer.from(decoded.signingInput, 'ascii'),
      publicKey,
      decoded.signature,
    );
  } catch {
    return false;
  }
}

/**
 * Encode + sign a compact JWS with an RSA private key. This is used by the
 * {@link import('../testing/local-oidc-issuer.ts').LocalOidcIssuer} test double to
 * mint *real* signed ID tokens (so verification is exercised for real, with no
 * network and no external IdP). It is not used by any production path.
 */
export function signCompactJws(
  header: JwsHeader,
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  alg: SupportedAlg,
): string {
  const hash = RSA_ALG_TO_HASH[alg];
  if (hash === undefined) throw new JwtMalformedError(`unsupported signing alg: ${alg}`);
  const encodedHeader = base64UrlEncode(JSON.stringify({ ...header, alg }));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = cryptoSign(hash, Buffer.from(signingInput, 'ascii'), privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}
