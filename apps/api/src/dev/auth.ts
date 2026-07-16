import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { users, type Db } from '../db/index.ts';
import { sendError } from '../routes/http.ts';
import {
  clearSessionCookie,
  resolveCurrentUserId,
  serializeSessionCookie,
  signSession,
  toIsoRequired,
} from './util.ts';

/**
 * Dev-login (DEV-ONLY) — the MOCK_MODE stand-in for OIDC (ARCHITECTURE §1:
 * `MOCK_MODE=1` swaps OIDC for a dev-login stub). Pick a fixture user, get a
 * signed session cookie + bearer token. No password, no external account.
 *
 * These routes do NOT gate anything: every read stays open (like the web's MSW),
 * so an unauthenticated web boot still loads. The session only lets the server
 * answer "who is `me`" for `owner in (me)` smart-view previews and `GET
 * /auth/me`. `GET /auth/dev-users` is the login picker source W1 already calls;
 * it returns the full User DTO (this is dev auth, distinct from the C7-minimal
 * `GET /users` reference read).
 */

export interface DevAuthRouteDeps {
  db: Db;
  sessionSecret: string;
}

const USER_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  idpSubject: users.idpSubject,
  isActive: users.isActive,
  timezone: users.timezone,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'rep' | 'admin';
  idpSubject: string;
  isActive: boolean;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

function mapUser(r: UserRow): UserRow {
  return { ...r, createdAt: toIsoRequired(r.createdAt), updatedAt: toIsoRequired(r.updatedAt) };
}

const loginSchema = z.object({ userId: z.string().uuid() });

export function registerDevAuthRoutes(app: FastifyInstance, deps: DevAuthRouteDeps): void {
  // GET /api/v1/auth/dev-users — the login picker (full User DTO).
  app.get('/api/v1/auth/dev-users', async () => {
    const rows = await deps.db.select(USER_COLUMNS).from(users).orderBy(asc(users.name));
    return rows.map(mapUser);
  });

  // POST /api/v1/auth/dev-login { userId } — set the signed session cookie.
  app.post('/api/v1/auth/dev-login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'userId (uuid) is required',
        parsed.error.flatten(),
      );
    }
    const rows = await deps.db
      .select(USER_COLUMNS)
      .from(users)
      .where(eq(users.id, parsed.data.userId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return sendError(reply, 'NOT_FOUND', 'user not found');
    const token = signSession(row.id, deps.sessionSecret);
    reply.header('set-cookie', serializeSessionCookie(token));
    return { user: mapUser(row), token };
  });

  // GET /api/v1/auth/me — the current dev user, or 401.
  app.get('/api/v1/auth/me', async (request, reply) => {
    const userId = resolveCurrentUserId(request, deps.sessionSecret);
    if (userId === null) return sendError(reply, 'UNAUTHENTICATED', 'no active session');
    const rows = await deps.db
      .select(USER_COLUMNS)
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    if (row === undefined)
      return sendError(reply, 'UNAUTHENTICATED', 'session user no longer exists');
    return mapUser(row);
  });

  // POST /api/v1/auth/logout — clear the session cookie.
  app.post('/api/v1/auth/logout', async (_request, reply) => {
    reply.header('set-cookie', clearSessionCookie());
    return { ok: true };
  });
}
