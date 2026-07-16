import type { FastifyInstance } from 'fastify';

/**
 * Security headers plugin (Task 5e). Adds a small, conservative set of response
 * headers via `onSend` (so they are applied last and a handler cannot weaken
 * them), on every response including 404s and errors.
 *
 *   - `x-content-type-options: nosniff`  — no MIME sniffing.
 *   - `x-frame-options: DENY`            — no framing (clickjacking).
 *   - `referrer-policy: no-referrer`     — never leak URLs cross-origin.
 *   - `cache-control: no-store` on /api  — API responses carry lead/PII data and
 *     must never be cached by intermediaries or the browser.
 *
 * Deliberately NO CSP and NO HSTS at this layer (ARCHITECTURE §8):
 *   - HSTS is a TRANSPORT concern. TLS is terminated at the internal LB / Fly
 *     proxy and the app speaks plain HTTP behind it; an app-set
 *     `Strict-Transport-Security` on an HTTP response is ineffective and belongs
 *     on the proxy that actually owns the TLS edge.
 *   - CSP is a DOCUMENT concern. This service serves a JSON API (and static
 *     assets are served by nginx/the proxy, §8), so a meaningful CSP is authored
 *     by whatever serves HTML, not here — a blanket API CSP would be theater.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface SecurityHeadersOptions {
  /** Path prefix that gets `cache-control: no-store`; default `/api`. */
  apiPathPrefix?: string;
  /** `referrer-policy` value; default `no-referrer`. */
  referrerPolicy?: string;
  /** `x-frame-options` value; default `DENY`. */
  frameOptions?: string;
}

function isUnderPrefix(url: string, prefix: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeadersOptions = {},
): void {
  const apiPathPrefix = options.apiPathPrefix ?? '/api';
  const referrerPolicy = options.referrerPolicy ?? 'no-referrer';
  const frameOptions = options.frameOptions ?? 'DENY';

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', frameOptions);
    reply.header('referrer-policy', referrerPolicy);
    if (isUnderPrefix(request.url, apiPathPrefix)) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}
