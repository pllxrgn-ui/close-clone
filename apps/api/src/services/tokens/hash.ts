import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API token secret material (Task 5c, CONTRACTS §C1: `api_tokens.hash` is a
 * sha256, "never plaintext"). The plaintext is shown to the creator EXACTLY ONCE
 * (see {@link import('./service.ts').TokenService.create}); only its sha256 hash is
 * persisted, so a database leak never yields usable credentials.
 *
 * sha256 (not bcrypt/argon2) is the right primitive here: an API token is a
 * high-entropy 256-bit random value, not a low-entropy human password, so there is
 * nothing to brute-force and a fast constant-time hash is exactly what lookup on
 * every request needs. This matches the C1 column definition (`hash (sha256)`).
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

/** Visible prefix so a leaked token is greppable/recognisable (à la `sk_`, `ghp_`). */
export const TOKEN_PREFIX = 'sbk_';

/** 256 bits of entropy → 43 base64url chars, after the prefix. */
const TOKEN_BYTES = 32;

/** Mint a fresh, unguessable token plaintext. Never persisted. */
export function generateTokenPlaintext(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

/** sha256 hex of a token plaintext — the value stored in `api_tokens.hash`. */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Shape check only (cheap pre-filter before a DB hash lookup). */
export function looksLikeToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length > TOKEN_PREFIX.length;
}

/**
 * Constant-time comparison of two sha256 hex digests. Used when a caller wants to
 * compare a presented token's hash against a stored one without leaking timing.
 * (Primary lookup is by indexed hash equality; this guards any in-memory compare.)
 */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
