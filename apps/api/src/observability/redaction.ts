/**
 * Observability redaction (Task 5e). Credential material must never reach a log
 * line, an error-tracking payload, or an alert event. This is the single
 * classifier + deep-redactor the logging serializers, the {@link ErrorSink}
 * context path, and the alert emitter all run untrusted data through.
 *
 * It deliberately mirrors the policy of `services/audit/redaction.ts` — match a
 * key by name, over-redact rather than risk a leak — but is kept self-contained
 * (no import from the audit service) and tuned for HTTP header names and
 * free-form log context. Matching is on a normalized key (lowercased,
 * non-alphanumerics stripped) so `X-Api-Key`, `x_api_key`, and `apiKey` all
 * match, while `authorId` does NOT (it does not contain `authorization`).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export const REDACTED = '[REDACTED]';

/** Guard against pathologically deep graphs (log context is not cyclic, but be safe). */
const MAX_DEPTH = 16;

/**
 * Normalized substrings that mark a field/header as secret anywhere they appear.
 * `authorization` also covers `proxy-authorization`; `cookie` also covers
 * `set-cookie`; `token` covers `x-auth-token`/`refresh_token`/`accessToken`.
 */
const SENSITIVE_SUBSTRINGS: readonly string[] = [
  'authorization',
  'cookie',
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'apikey',
  'oauth',
  'credential',
  'privatekey',
  'sessionid',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when a field/header name should have its value redacted. */
export function isSensitiveField(name: string): boolean {
  const n = normalizeKey(name);
  if (n.length === 0) return false;
  return SENSITIVE_SUBSTRINGS.some((marker) => n.includes(marker));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) {
    // Too deep to keep walking: keep primitives, wipe any remaining structure
    // wholesale (a secret could hide arbitrarily deep below this point).
    return isPlainObject(value) || Array.isArray(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSensitiveField(key) ? REDACTED : redactValue(child, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Return a redacted deep copy of arbitrary log/error context. Any key whose name
 * looks like a credential has its value (however nested) replaced with
 * `[REDACTED]`. Primitives pass through; the input is never mutated.
 */
export function redactDeep(value: unknown): unknown {
  return redactValue(value, 0);
}

/**
 * Redact a header bag by NAME. Sensitive header values (string or string[]) are
 * replaced with `[REDACTED]`; the key names are kept so a log still shows which
 * headers were present. Non-sensitive values pass through untouched. Never
 * mutates the input.
 */
export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveField(key) ? REDACTED : value;
  }
  return out;
}
