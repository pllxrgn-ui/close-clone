/**
 * base64url + constant-time compare primitives (Task 5a). Shared by the JWT
 * codec, the signed-cookie codec, PKCE, and CSRF. No dependencies beyond
 * `node:crypto`/`Buffer` — the whole auth module ships without adding a package
 * (JWKS/JWT verification is done with `node:crypto`, not `jose`; see the module
 * README note in the task report).
 */
import { timingSafeEqual } from 'node:crypto';

/** RFC 4648 §5 base64url (no padding). */
export function base64UrlEncode(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');
}

/** Decode base64url to bytes. Invalid input yields a best-effort/empty buffer. */
export function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/** Decode base64url to a UTF-8 string. */
export function base64UrlDecodeToString(input: string): string {
  return base64UrlDecode(input).toString('utf8');
}

/**
 * Length-safe, constant-time string equality. Used for every secret/token
 * comparison (HMAC tags, state, CSRF) so equality never leaks via timing. A
 * length mismatch returns `false` without calling `timingSafeEqual` (which throws
 * on unequal-length buffers).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
