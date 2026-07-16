import { createHmac } from 'node:crypto';

import { base64UrlDecodeToString, base64UrlEncode, constantTimeEqual } from '../encoding.ts';

/**
 * Cookie serialization + HMAC-signed payloads (Task 5a). Two orthogonal pieces
 * the session and OIDC-transaction codecs build on:
 *
 *  1. {@link serializeCookie}/{@link parseCookies} — `Set-Cookie` string building
 *     and request `Cookie` header parsing (no `@fastify/cookie` dependency; the
 *     repo already parses cookies by hand in `dev/util.ts`).
 *  2. {@link signValue}/{@link verifyValue} — a compact `base64url(json).hmacTag`
 *     token. Any tamper (payload or tag) fails the constant-time tag check and
 *     returns `null` — the caller treats that as "no valid cookie" (→ 401).
 */

export type SameSite = 'Lax' | 'Strict' | 'None';

export interface CookieAttributes {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSite;
  /** Cookie `Max-Age` in seconds. Omit for a session cookie; `0` clears it. */
  maxAgeSeconds?: number;
}

/** Build a `Set-Cookie` header value. `HttpOnly`/`Secure` are opt-in but on by default. */
export function serializeCookie(name: string, value: string, attrs: CookieAttributes = {}): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${attrs.path ?? '/'}`);
  if (attrs.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(attrs.maxAgeSeconds)}`);
  if (attrs.httpOnly !== false) parts.push('HttpOnly');
  if (attrs.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${attrs.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

/** Parse a request `Cookie` header into a name→value map. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    if (!out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

/** Sign a JSON-serializable payload: `base64url(json).base64urlHmacSha256`. */
export function signValue(payload: unknown, secret: string): string {
  const body = base64UrlEncode(JSON.stringify(payload));
  const tag = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${tag}`;
}

/**
 * Verify + decode a {@link signValue} token. Returns the parsed payload, or `null`
 * on any tamper/mismatch/parse failure. The tag comparison is constant-time.
 */
export function verifyValue(token: string, secret: string): unknown {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const tag = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!constantTimeEqual(tag, expected)) return null;
  try {
    return JSON.parse(base64UrlDecodeToString(body));
  } catch {
    return null;
  }
}
