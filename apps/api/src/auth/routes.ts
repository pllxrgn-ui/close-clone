import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import { sendError } from '../routes/http.ts';
import { auditDenied, auditLogin, auditLogout } from './auth-audit.ts';
import { loadActiveUser } from './guards.ts';
import {
  IdTokenInvalidError,
  OidcClient,
  OidcStateMismatchError,
  OidcTokenResponseError,
} from './oidc/index.ts';
import { groupsToRole } from './rbac.ts';
import { provisionUser } from './provisioning.ts';
import type { SessionCodec } from './session/session.ts';
import type { OidcTxnCodec } from './session/txn.ts';

/**
 * OIDC auth routes (Task 5a) — the real-mode issuer that replaces the MOCK_MODE
 * dev-login stub (`dev/auth.ts`). Mounted OUTSIDE requireSession (login/callback
 * are pre-session; me/logout read the session themselves):
 *
 *   GET  /api/v1/auth/login    → begin PKCE flow, stash txn cookie, 302 to IdP
 *   GET  /api/v1/auth/callback → validate state, exchange code, verify ID token,
 *                                map groups→role, upsert user, issue session, 302
 *   POST /api/v1/auth/logout   → revoke (clear) the session cookie
 *   GET  /api/v1/auth/me       → the current user, or 401
 *
 * Every login/denial/logout is audited (auth-audit.ts) with the caller IP. No
 * local passwords exist anywhere in this flow — the IdP assertion is the only
 * credential, and it is never persisted.
 */

export interface OidcAuthRouteDeps {
  db: Db;
  client: OidcClient;
  session: SessionCodec;
  txn: OidcTxnCodec;
  /** Absolute callback URL registered with the IdP (must match on exchange). */
  redirectUri: string;
  /** Where the browser lands after a successful login (default `/`). */
  postLoginRedirect?: string;
  /** Where the browser lands after a failed/denied login (default `/login`). */
  loginErrorRedirect?: string;
}

const callbackQuerySchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .passthrough();

function reasonFromError(err: unknown): string {
  if (err instanceof OidcStateMismatchError) return 'bad_state';
  if (err instanceof IdTokenInvalidError) return `idtoken:${err.reason}`;
  if (err instanceof OidcTokenResponseError) return 'bad_token_response';
  return 'exchange_error';
}

export function registerOidcAuthRoutes(app: FastifyInstance, deps: OidcAuthRouteDeps): void {
  const postLogin = deps.postLoginRedirect ?? '/';
  const loginError = deps.loginErrorRedirect ?? '/login';

  /** Clear the txn cookie and bounce to the login page with a coarse reason. */
  function failRedirect(reply: FastifyReply, reason: string): FastifyReply {
    reply.header('set-cookie', deps.txn.clear());
    const sep = loginError.includes('?') ? '&' : '?';
    return reply.redirect(`${loginError}${sep}error=${encodeURIComponent(reason)}`);
  }

  app.get('/api/v1/auth/login', async (request, reply) => {
    try {
      const login = await deps.client.beginLogin(deps.redirectUri);
      reply.header(
        'set-cookie',
        deps.txn.issue({
          state: login.state,
          nonce: login.nonce,
          codeVerifier: login.codeVerifier,
        }),
      );
      return reply.redirect(login.authorizationUrl);
    } catch (err) {
      request.log.error({ err }, 'OIDC beginLogin failed');
      return failRedirect(reply, 'idp_unavailable');
    }
  });

  app.get('/api/v1/auth/callback', async (request, reply) => {
    const ip = request.ip;
    const parsed = callbackQuerySchema.safeParse(request.query);
    if (!parsed.success) return failRedirect(reply, 'invalid_callback');
    const q = parsed.data;

    if (q.error !== undefined) {
      await auditDenied(deps.db, { reason: `idp_error:${q.error}`, ip });
      return failRedirect(reply, 'idp_error');
    }
    if (q.code === undefined || q.state === undefined) {
      return failRedirect(reply, 'missing_code');
    }

    const txn = deps.txn.read(request.headers.cookie);
    if (txn === null) return failRedirect(reply, 'expired');

    let claims;
    try {
      const result = await deps.client.completeLogin({
        code: q.code,
        returnedState: q.state,
        expected: txn,
        redirectUri: deps.redirectUri,
      });
      claims = result.claims;
    } catch (err) {
      await auditDenied(deps.db, { reason: reasonFromError(err), ip });
      return failRedirect(reply, 'exchange_failed');
    }

    const role = groupsToRole(claims.groups);
    if (role === null) {
      await auditDenied(deps.db, {
        reason: 'no_group',
        ip,
        snapshot: { idpSubject: claims.sub, email: claims.email ?? null },
      });
      return failRedirect(reply, 'no_access');
    }

    const email = claims.email;
    if (email === undefined) {
      await auditDenied(deps.db, { reason: 'no_email', ip, snapshot: { idpSubject: claims.sub } });
      return failRedirect(reply, 'no_email');
    }

    let provision;
    try {
      provision = await provisionUser(deps.db, {
        idpSubject: claims.sub,
        email,
        name: claims.name ?? email,
        role,
      });
    } catch (err) {
      request.log.error({ err }, 'OIDC provisioning failed');
      await auditDenied(deps.db, {
        reason: 'provisioning_failed',
        ip,
        snapshot: { idpSubject: claims.sub, email },
      });
      return failRedirect(reply, 'provisioning_failed');
    }

    if (provision.status === 'inactive') {
      await auditDenied(deps.db, { reason: 'inactive', userId: provision.user.id, ip });
      return failRedirect(reply, 'inactive');
    }

    await auditLogin(deps.db, {
      userId: provision.user.id,
      ip,
      snapshot: { email: provision.user.email, role: provision.user.role },
    });
    reply.header('set-cookie', [deps.session.issue(provision.user.id), deps.txn.clear()]);
    return reply.redirect(postLogin);
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const resolution = deps.session.read(request.headers.cookie);
    if (resolution !== null) {
      await auditLogout(deps.db, { userId: resolution.userId, ip: request.ip });
    }
    reply.header('set-cookie', deps.session.clear());
    return { ok: true };
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    const resolution = deps.session.read(request.headers.cookie);
    if (resolution === null) return sendError(reply, 'UNAUTHENTICATED', 'no active session');
    const user = await loadActiveUser(deps.db, resolution.userId);
    if (user === null) {
      return sendError(reply, 'UNAUTHENTICATED', 'session user no longer exists or is inactive');
    }
    if (resolution.refreshedSetCookie !== undefined) {
      reply.header('set-cookie', resolution.refreshedSetCookie);
    }
    return user;
  });
}
