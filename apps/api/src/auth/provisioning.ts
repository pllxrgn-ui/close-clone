import { eq, sql } from 'drizzle-orm';

import { users, type Db } from '../db/index.ts';
import type { AuthenticatedUser, Role } from './types.ts';

/**
 * Just-in-time user provisioning (Task 5a, CONTRACTS §C1). The IdP `sub` is the
 * stable identity: {@link provisionUser} upserts the `users` row keyed on
 * `idp_subject` (unique) inside one transaction with a row lock, so two concurrent
 * logins for the same subject can't race to create duplicate rows.
 *
 *  - New subject → provisioned active with the group-derived role.
 *  - Existing + active → email/name/role are refreshed from the IdP (groups are
 *    authoritative for role — see rbac.ts).
 *  - Existing + `is_active=false` → returned as `inactive` and NOT touched; the
 *    caller refuses the login and audits `auth.denied`. Admin deactivation is
 *    never silently undone by a login.
 *
 * There is no local password anywhere — this module only ever reads the IdP
 * assertion. Import-safe for direct `node` execution (no parameter properties).
 */

const USER_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  isActive: users.isActive,
  timezone: users.timezone,
} as const;

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  timezone: string;
}

function toAuthUser(row: UserRow): AuthenticatedUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    timezone: row.timezone,
  };
}

export interface ProvisionUserInput {
  idpSubject: string;
  email: string;
  name: string;
  role: Role;
}

export type ProvisionResult =
  { status: 'ok'; user: AuthenticatedUser } | { status: 'inactive'; user: AuthenticatedUser };

export async function provisionUser(db: Db, input: ProvisionUserInput): Promise<ProvisionResult> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select(USER_COLUMNS)
      .from(users)
      .where(eq(users.idpSubject, input.idpSubject))
      .for('update')
      .limit(1);
    const current = existing[0];

    if (current !== undefined) {
      if (!current.isActive) return { status: 'inactive', user: toAuthUser(current) };
      const [updated] = await tx
        .update(users)
        .set({ email: input.email, name: input.name, role: input.role, updatedAt: sql`now()` })
        .where(eq(users.id, current.id))
        .returning(USER_COLUMNS);
      if (updated === undefined) throw new Error('provisionUser: update returned no row');
      return { status: 'ok', user: toAuthUser(updated) };
    }

    const [created] = await tx
      .insert(users)
      .values({
        email: input.email,
        name: input.name,
        role: input.role,
        idpSubject: input.idpSubject,
        isActive: true,
      })
      .returning(USER_COLUMNS);
    if (created === undefined) throw new Error('provisionUser: insert returned no row');
    return { status: 'ok', user: toAuthUser(created) };
  });
}
