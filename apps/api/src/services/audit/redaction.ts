import type { AuditSnapshot } from './actions.ts';

/**
 * Snapshot redaction (Task 5b). Audit before/after snapshots capture record
 * state, and some records carry secret material — most importantly
 * `email_accounts.oauth_tokens` (encrypted OAuth tokens) and `api_tokens.hash`.
 * None of it may ever surface through the audit trail (the admin query endpoint
 * must "never return oauth token material even if present in before/after").
 *
 * `redactSnapshot` walks the object graph and replaces the value of any key that
 * looks like a credential with `[REDACTED]`. It is applied at BOTH write time
 * (so the persisted row is already clean — defense in depth) and read time (so
 * the endpoint is safe even for rows written by a path that forgot to redact, or
 * inserted out of band). It returns a fresh object and never mutates its input.
 *
 * Matching is deliberately conservative — over-redacting a rare field named
 * exactly `hash`/`token` is acceptable; leaking a token is not. Import-safe for
 * direct `node` execution (no enums / namespaces / parameter properties).
 */

export const REDACTED = '[REDACTED]';

/** Guard against pathologically deep graphs (DB JSON is not cyclic, but be safe). */
const MAX_DEPTH = 16;

/**
 * Normalized keys (lowercased, non-alphanumerics stripped) that are always
 * secret regardless of surrounding context.
 */
const SENSITIVE_EXACT: ReadonlySet<string> = new Set([
  'hash',
  'authorization',
  'credentials',
  'credential',
  'cookie',
  'setcookie',
]);

/**
 * Normalized substrings that mark a key as secret anywhere they appear
 * (`googleAccessToken`, `refresh_token`, `oauthTokens`, `clientSecret`, …).
 */
const SENSITIVE_SUBSTRINGS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'oauth',
  'apikey',
  'privatekey',
  'accesskey',
  'sessionsecret',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when a key name should have its value redacted. Exported for testing. */
export function isSensitiveKey(key: string): boolean {
  const n = normalizeKey(key);
  if (n.length === 0) return false;
  if (SENSITIVE_EXACT.has(n)) return true;
  return SENSITIVE_SUBSTRINGS.some((marker) => n.includes(marker));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) {
    // Too deep to keep walking: keep primitives, drop any remaining structure.
    return isPlainObject(value) || Array.isArray(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(child, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Return a redacted deep copy of a snapshot. Any credential-looking key has its
 * value (however nested — object, array element, or scalar) replaced with
 * `[REDACTED]`. The input is not mutated.
 */
export function redactSnapshot(snapshot: AuditSnapshot): AuditSnapshot {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(snapshot)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(child, 1);
  }
  return result;
}
