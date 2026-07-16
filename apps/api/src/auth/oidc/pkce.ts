import { createHash, randomBytes } from 'node:crypto';

import { base64UrlEncode } from '../encoding.ts';

/**
 * PKCE (RFC 7636) + CSPRNG state/nonce (Task 5a). PKCE binds the authorization
 * code to the client instance that started the flow, so an intercepted code is
 * useless without the (never-transmitted) verifier — mandatory for a public/SPA
 * client and cheap insurance for a confidential one. `state` and `nonce` are
 * independent 256-bit random tokens: `state` defeats login CSRF, `nonce` binds
 * the returned ID token to this exact request (checked in id-token.ts).
 */

/** A URL-safe, 256-bit random token (base64url, ~43 chars). */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(randomBytes(bytes));
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** Create a PKCE verifier + S256 challenge (`challenge = base64url(sha256(verifier))`). */
export function createPkce(): Pkce {
  const verifier = randomToken(32);
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}
