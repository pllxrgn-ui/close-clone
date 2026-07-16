import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Dev-server shared helpers (Task: one-command MOCK_MODE dev server).
 *
 * This whole `dev/` tree is DEV-ONLY glue: it boots the real Fastify route
 * plugins against embedded PGlite + the golden fixture and adds the read-only
 * shims (leads, smart-views, reference reads, dev-login) the web calls but which
 * have no REST route on this branch yet. Nothing here is a compliance rail and
 * nothing here runs in production — the real API composition root replaces it.
 *
 * Helpers only: ISO timestamp coercion, an opaque keyset cursor codec, and a
 * tiny HMAC-signed session token (the dev-login cookie/bearer). No new deps.
 */

// --- Timestamps -------------------------------------------------------------

/**
 * Drizzle reads `timestamptz` columns (mode:'string') back in Postgres text form
 * (`2026-07-10 12:34:56+00`), but the web (and its MSW fixtures) speak ISO-8601
 * with a `T`/`Z` (`2026-07-10T12:34:56.000Z`). Normalise every timestamp we hand
 * to the client so date parsing on the web is identical to mock mode.
 */
export function toIso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** Non-null variant for required timestamps (created_at/updated_at/occurred_at). */
export function toIsoRequired(value: string): string {
  return new Date(value).toISOString();
}

// --- Opaque keyset cursor ---------------------------------------------------

export interface CursorParts {
  /** Last row's sort-column value from the previous page. */
  v: string | number | boolean | null;
  /** Last row's id (keyset tiebreak). */
  id: string;
}

/** Encode a keyset cursor as an opaque base64url token (C7: cursors are opaque). */
export function encodeCursor(parts: CursorParts): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/** Decode a cursor token; `null` when malformed (caller maps that to 400). */
export function decodeCursor(raw: string): CursorParts | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      return null;
    }
    const { v, id } = parsed as { v: unknown; id: string };
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      return null;
    }
    return { v, id };
  } catch {
    return null;
  }
}

// --- Dev session token (HMAC-signed cookie / bearer) ------------------------

/**
 * A dev session is just a signed user id: `<userId>.<hmacSha256(userId)>`. This
 * is the MOCK_MODE stand-in for a real OIDC session cookie (ARCHITECTURE §1:
 * `MOCK_MODE=1` swaps OIDC for a dev-login stub). It authenticates nothing of
 * value — it only lets the server resolve "who is `me`" for `owner in (me)`
 * smart-view previews; every read route stays open, exactly like the web's MSW.
 */
export const SESSION_COOKIE = 'sb_dev_session';

export function signSession(userId: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(userId).digest('base64url');
  return `${userId}.${sig}`;
}

export function verifySession(token: string, secret: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const expected = createHmac('sha256', secret).update(userId).digest('base64url');
  const got = token.slice(dot + 1);
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}

/** Serialize the dev session cookie (Lax so it survives the Vite same-origin proxy). */
export function serializeSessionCookie(token: string, maxAgeSeconds = 60 * 60 * 24 * 7): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** Serialize a cookie that clears the dev session. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Resolve the signed-in dev user from a `Bearer` token or the session cookie.
 * Returns the user id, or `null` when there is no valid session (routes stay
 * open regardless — this only supplies `me`).
 */
export function resolveCurrentUserId(request: FastifyRequest, secret: string): string | null {
  const auth = request.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const fromBearer = verifySession(auth.slice(7).trim(), secret);
    if (fromBearer !== null) return fromBearer;
  }
  const cookie = readCookie(request.headers['cookie'], SESSION_COOKIE);
  if (cookie !== null) return verifySession(cookie, secret);
  return null;
}
