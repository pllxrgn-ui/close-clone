import type { IncomingHttpHeaders } from 'node:http';

/**
 * CSRF defense for the internal SPA (Task 5a). Two layers, no per-request CSRF
 * token needed:
 *
 *  1. The session cookie is `SameSite=Lax`, so a cross-site page cannot cause the
 *     browser to attach it to a state-changing (non-GET) request at all.
 *  2. Mutating requests must additionally carry a custom header. A browser will
 *     not let a cross-origin page set a custom request header without a CORS
 *     preflight, and the API grants CORS to its own origin only — so the header's
 *     presence proves the request came from our own first-party JS (fetch/XHR),
 *     not from a forged cross-site form or navigation.
 *
 * A classic double-submit *token* is not usable here because the session cookie is
 * httpOnly (our own JS cannot read a value to mirror). Requiring the custom header
 * on mutating methods is the correct fit and is what an internal same-origin SPA
 * needs. GET/HEAD/OPTIONS are safe methods and are never gated.
 */

export const CSRF_HEADER = 'x-switchboard-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isMutatingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * True if the request carries a non-empty CSRF header. The value is not checked
 * against anything — its *presence* is the signal (only same-origin JS can set it).
 */
export function hasCsrfHeader(
  headers: IncomingHttpHeaders,
  headerName: string = CSRF_HEADER,
): boolean {
  const value = headers[headerName.toLowerCase()];
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.some((v) => v.length > 0);
  return false;
}
