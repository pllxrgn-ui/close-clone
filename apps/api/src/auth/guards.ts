import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { eq } from 'drizzle-orm';

import { users, type Db } from '../db/index.ts';
import { sendError } from '../routes/http.ts';
import { CSRF_HEADER, hasCsrfHeader, isMutatingMethod } from './csrf.ts';
import type { AuthenticatedUser, SessionReader } from './types.ts';

/**
 * RBAC guards (Task 5a) — the exported preHandler factories the composition root
 * mounts. They sit ABOVE the session seam: {@link SessionGuardDeps.readSession} is
 * injected (real OIDC-session reader, or the MOCK_MODE dev-login reader), so no
 * guard branches on MOCK_MODE.
 *
 *  - {@link requireSession}: `/api/v1/*` gate. 401 if no valid session; 403 if a
 *    mutating request lacks the CSRF header; 401 if the session's user is gone or
 *    `is_active=false` (deactivation is enforced here, every request — so it takes
 *    effect immediately regardless of session lifetime). On success it attaches
 *    `request.user` + `request.actor` and echoes any sliding-renewal cookie.
 *  - {@link requireAdmin}: the real `adminGuard` the audit/export routes expect
 *    (`preHandlerHookHandler`). Self-contained (session + CSRF + admin role), and
 *    reuses `request.user` when requireSession already ran.
 */

const USER_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  isActive: users.isActive,
  timezone: users.timezone,
} as const;

/** Load the user by id, returning `null` if missing OR deactivated. */
export async function loadActiveUser(db: Db, userId: string): Promise<AuthenticatedUser | null> {
  const rows = await db.select(USER_COLUMNS).from(users).where(eq(users.id, userId)).limit(1);
  const row = rows[0];
  if (row === undefined || !row.isActive) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    timezone: row.timezone,
  };
}

export interface SessionGuardDeps {
  db: Db;
  readSession: SessionReader;
  /** Enforce the custom-header CSRF check on mutating methods (default true). */
  csrf?: boolean;
  /** Override the CSRF header name (default {@link CSRF_HEADER}). */
  csrfHeader?: string;
}

/**
 * Shared resolution: session → CSRF → active user. On any failure it sends the C8
 * error and returns `null`; on success it decorates the request and returns the
 * user. (401 for auth problems, 403 for the CSRF gate — matches the acceptance
 * matrix: cookie tamper → 401, CSRF header missing → 403.)
 */
async function resolveSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: SessionGuardDeps,
): Promise<AuthenticatedUser | null> {
  const resolution = deps.readSession(request);
  if (resolution === null) {
    sendError(reply, 'UNAUTHENTICATED', 'no active session');
    return null;
  }
  if (
    deps.csrf !== false &&
    isMutatingMethod(request.method) &&
    !hasCsrfHeader(request.headers, deps.csrfHeader ?? CSRF_HEADER)
  ) {
    sendError(reply, 'FORBIDDEN', 'missing CSRF header on a mutating request');
    return null;
  }
  const user = await loadActiveUser(deps.db, resolution.userId);
  if (user === null) {
    sendError(reply, 'UNAUTHENTICATED', 'session user no longer exists or is inactive');
    return null;
  }
  if (resolution.refreshedSetCookie !== undefined) {
    reply.header('set-cookie', resolution.refreshedSetCookie);
  }
  request.user = user;
  request.actor = { id: user.id, type: 'user' };
  return user;
}

/** `/api/v1/*` session gate (exclude /wh/*, unsubscribe, /healthz, dev-login). */
export function requireSession(deps: SessionGuardDeps): preHandlerHookHandler {
  return async (request, reply) => {
    const user = await resolveSession(request, reply, deps);
    if (user === null) return reply;
  };
}

/** Admin gate for `admin/*` — the real `adminGuard` for the audit/export routes. */
export function requireAdmin(deps: SessionGuardDeps): preHandlerHookHandler {
  return async (request, reply) => {
    let user = request.user;
    if (user === undefined) {
      const resolved = await resolveSession(request, reply, deps);
      if (resolved === null) return reply;
      user = resolved;
    }
    if (user.role !== 'admin') {
      return sendError(reply, 'FORBIDDEN', 'admin role required');
    }
  };
}
