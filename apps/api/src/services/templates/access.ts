import { and, eq } from 'drizzle-orm';
import { users, type Db } from '../../db/index.ts';

/**
 * Shared guards + keyset cursor for the templates/snippets services (task 2d).
 * Until the session/auth layer (5a) lands, the acting user is carried explicitly
 * (`actorId`) — this module is the single seam that will instead read the
 * authenticated principal. Every mutation requires a valid, ACTIVE user, so there
 * is no anonymous write path (RBAC-safe default, matching the 2c triage engine).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The actor is missing, unknown, or not an active user. */
export class InvalidActorError extends Error {
  readonly actorId: string;
  constructor(actorId: string) {
    super(`actor ${actorId} is not a permitted, active user`);
    this.name = 'InvalidActorError';
    this.actorId = actorId;
  }
}

/** A malformed pagination cursor. */
export class InvalidCursorError extends Error {
  constructor(cursor: string) {
    super(`bad cursor ${cursor}`);
    this.name = 'InvalidCursorError';
  }
}

export async function assertActiveUser(exec: Db, actorId: string): Promise<void> {
  if (!UUID_RE.test(actorId)) throw new InvalidActorError(actorId);
  const rows = await exec
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actorId), eq(users.isActive, true)))
    .limit(1);
  if (rows[0] === undefined) throw new InvalidActorError(actorId);
}

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError(cursor);
  }
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) throw new InvalidCursorError(cursor);
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!UUID_RE.test(id) || Number.isNaN(Date.parse(createdAt)))
    throw new InvalidCursorError(cursor);
  return { createdAt, id };
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}
