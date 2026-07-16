import { z } from 'zod';

import { constantTimeEqual } from '../encoding.ts';
import { decodeJwt, isSupportedAlg, JwtMalformedError, verifyJwsSignature } from './jwt.ts';
import { JwksCache, JwksKeyNotFoundError } from './jwks.ts';

/**
 * ID-token verification (Task 5a) — the heart of "trust this IdP assertion". The
 * order is deliberate and fail-closed: structural decode → alg allow-list → key
 * resolution by `kid` → **signature** → standard claims (iss/aud/exp/iat) with
 * clock-skew tolerance → **nonce** binding. Signature is checked before any claim
 * is trusted; nonce is checked so a replayed or injected token from a different
 * login can't be accepted. Every rejection carries a machine `reason` so the
 * caller can audit `auth.denied` with a precise cause.
 */

export type IdTokenRejectReason =
  | 'malformed'
  | 'unsupported_alg'
  | 'missing_kid'
  | 'unknown_kid'
  | 'bad_signature'
  | 'claims_invalid'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'expired'
  | 'issued_in_future'
  | 'not_yet_valid'
  | 'nonce_mismatch';

export class IdTokenInvalidError extends Error {
  readonly reason: IdTokenRejectReason;
  constructor(reason: IdTokenRejectReason, message?: string) {
    super(message ?? `id token rejected: ${reason}`);
    this.name = 'IdTokenInvalidError';
    this.reason = reason;
  }
}

const claimsSchema = z
  .object({
    iss: z.string().min(1),
    sub: z.string().min(1),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    exp: z.number(),
    iat: z.number(),
    nbf: z.number().optional(),
    nonce: z.string().optional(),
    email: z.string().optional(),
    email_verified: z.boolean().optional(),
    name: z.string().optional(),
    groups: z.array(z.string()).optional(),
  })
  .passthrough();

export type IdTokenClaims = z.infer<typeof claimsSchema>;

export interface VerifyIdTokenParams {
  token: string;
  /** Exact expected issuer (matches the discovery `issuer`). */
  issuer: string;
  /** Expected audience — the OAuth client id. */
  audience: string;
  /** Expected nonce from the login transaction. */
  nonce: string;
  jwks: JwksCache;
  now?: () => Date;
  clockSkewSec?: number;
}

const DEFAULT_SKEW_SEC = 60;

function audienceMatches(aud: string | string[], expected: string): boolean {
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

/**
 * Verify an OIDC ID token. Resolves to the validated claims, or throws
 * {@link IdTokenInvalidError}. A JWKS network failure (not a missing key) is left
 * to propagate as its own transport error so the caller can treat it as transient.
 */
export async function verifyIdToken(params: VerifyIdTokenParams): Promise<IdTokenClaims> {
  const skew = params.clockSkewSec ?? DEFAULT_SKEW_SEC;
  const nowSec = Math.floor((params.now ?? (() => new Date()))().getTime() / 1000);

  let decoded;
  try {
    decoded = decodeJwt(params.token);
  } catch (err) {
    if (err instanceof JwtMalformedError) throw new IdTokenInvalidError('malformed', err.message);
    throw err;
  }

  if (!isSupportedAlg(decoded.header.alg)) {
    throw new IdTokenInvalidError('unsupported_alg', `alg '${decoded.header.alg}' not accepted`);
  }
  const kid = decoded.header.kid;
  if (kid === undefined) throw new IdTokenInvalidError('missing_kid');

  let key;
  try {
    key = await params.jwks.getKey(kid);
  } catch (err) {
    if (err instanceof JwksKeyNotFoundError) {
      throw new IdTokenInvalidError('unknown_kid', err.message);
    }
    throw err; // transport/parse error — transient, not a token rejection
  }

  if (!verifyJwsSignature(decoded, key)) {
    throw new IdTokenInvalidError('bad_signature');
  }

  const parsed = claimsSchema.safeParse(decoded.payload);
  if (!parsed.success) {
    throw new IdTokenInvalidError('claims_invalid', parsed.error.message);
  }
  const claims = parsed.data;

  if (claims.iss !== params.issuer) {
    throw new IdTokenInvalidError('issuer_mismatch', `iss '${claims.iss}'`);
  }
  if (!audienceMatches(claims.aud, params.audience)) {
    throw new IdTokenInvalidError('audience_mismatch');
  }
  if (nowSec > claims.exp + skew) {
    throw new IdTokenInvalidError('expired');
  }
  if (claims.iat > nowSec + skew) {
    throw new IdTokenInvalidError('issued_in_future');
  }
  if (claims.nbf !== undefined && claims.nbf > nowSec + skew) {
    throw new IdTokenInvalidError('not_yet_valid');
  }
  // Nonce binds the token to THIS login. Constant-time to avoid leaking it.
  if (claims.nonce === undefined || !constantTimeEqual(claims.nonce, params.nonce)) {
    throw new IdTokenInvalidError('nonce_mismatch');
  }

  return claims;
}
