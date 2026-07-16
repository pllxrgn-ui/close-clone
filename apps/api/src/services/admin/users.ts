import { asc, eq } from 'drizzle-orm';
import type { User } from '@switchboard/shared';
import { users, type Db } from '../../db/index.ts';
import { writeAudit } from '../audit/index.ts';
import { AdminNotFoundError, AdminValidationError } from './errors.ts';
import type { AdminActor } from './types.ts';

/**
 * Admin user management (CONTRACTS §C1 `users`, §C7 `admin/*` — admin RBAC). Two
 * routes:
 *   - `GET /admin/users` — the FULL user DTO (role + timezone + timestamps),
 *     distinct from the rep-accessible `GET /users` reference read which is the
 *     minimal label-only shape (C7: "never tokens/idp fields"). `idp_subject` is
 *     an identity-provider correlator, not a secret, but it is not needed by the
 *     admin table and is omitted here to keep the surface minimal.
 *   - `PATCH /admin/users/:id` — flip `is_active` (de/re-activate an account),
 *     audited as `admin.user_changed`.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

type UserDto = Omit<User, 'idpSubject'>;

const SELECT_COLS = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  isActive: users.isActive,
  timezone: users.timezone,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function toDto(r: {
  id: string;
  email: string;
  name: string;
  role: 'rep' | 'admin';
  isActive: boolean;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}): UserDto {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    isActive: r.isActive,
    timezone: r.timezone,
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
  };
}

/** List every user (full admin shape), ordered by name for a stable table. */
export async function listUsers(db: Db): Promise<UserDto[]> {
  const rows = await db.select(SELECT_COLS).from(users).orderBy(asc(users.name), asc(users.id));
  return rows.map(toDto);
}

export interface SetUserActiveInput {
  isActive: unknown;
}

/**
 * Set a user's active flag. Accepts either `isActive` (C7 camelCase) or the
 * `is_active` alias so whichever the eventual caller sends works. A change to the
 * same value is still applied + audited (idempotent from the caller's view).
 */
export async function setUserActive(
  db: Db,
  id: string,
  input: { isActive?: unknown; is_active?: unknown },
  actor: AdminActor,
): Promise<UserDto> {
  const raw = input.isActive !== undefined ? input.isActive : input.is_active;
  if (typeof raw !== 'boolean') {
    throw new AdminValidationError('isActive must be a boolean', { field: 'isActive' });
  }

  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const current = await tx.select(SELECT_COLS).from(users).where(eq(users.id, id)).limit(1);
    const before = current[0];
    if (before === undefined) throw new AdminNotFoundError('User not found');

    const updated = await tx
      .update(users)
      .set({ isActive: raw })
      .where(eq(users.id, id))
      .returning(SELECT_COLS);
    const row = toDto(updated[0]!);
    await writeAudit(tx, {
      action: 'admin.user_changed',
      entity: 'user',
      entityId: id,
      actorType: actor.type,
      actorId: actor.id,
      before: { isActive: before.isActive },
      after: { isActive: row.isActive },
      ip: actor.ip,
    });
    return row;
  });
}
