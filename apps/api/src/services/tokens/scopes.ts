import { z } from 'zod';

/**
 * API token scopes (Task 5c, CONTRACTS §C7 "internal API, scoped" / §C8 FORBIDDEN).
 *
 * A deliberately small, sane set. Every internal REST route declares the ONE scope
 * it requires; the bearer preHandler ({@link import('./pre-handler.ts')}) refuses a
 * token that lacks it with `FORBIDDEN` (403).
 *
 *   - `read:leads`    — read leads, contacts, opportunities, timelines.
 *   - `write:leads`   — create/update those records AND the write actions that ride
 *                       on them (send email, enroll a sequence). Compliance rails
 *                       still apply — a write scope is permission to *ask* the
 *                       engine, never to bypass it (I-RAIL-API).
 *   - `read:reports`  — read the `reports/*` surface.
 *   - `admin`         — the admin surface (suppressions, tokens, webhooks,
 *                       org-settings, audit-log). A SUPERSCOPE: it satisfies every
 *                       other scope requirement, matching its role as the
 *                       highest-privilege grant. All other scopes are additive and
 *                       independent (a token may hold several).
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export const API_SCOPES = ['read:leads', 'write:leads', 'read:reports', 'admin'] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const apiScopeSchema = z.enum(API_SCOPES);

/** The superscope that satisfies every scope requirement. */
export const ADMIN_SCOPE: ApiScope = 'admin';

const SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

/** Type guard: is `value` one of the known scopes? */
export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === 'string' && SCOPE_SET.has(value);
}

/**
 * Coerce an untyped `scopes` jsonb array (the DB column is `jsonb<unknown[]>`) into
 * a deduped list of known scopes. Unknown entries are dropped, not an error — the
 * DB column is permissive; the read side is strict.
 */
export function parseScopes(raw: unknown): ApiScope[] {
  if (!Array.isArray(raw)) return [];
  const out: ApiScope[] = [];
  for (const entry of raw) {
    if (isApiScope(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * True iff a token holding `granted` may access a route requiring `required`.
 * `admin` is a superscope and satisfies any requirement.
 */
export function hasScope(granted: readonly ApiScope[], required: ApiScope): boolean {
  return granted.includes(ADMIN_SCOPE) || granted.includes(required);
}
