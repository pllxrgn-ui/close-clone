import {
  writeAudit,
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditSnapshot,
} from '../services/audit/index.ts';
import type { Db } from '../db/index.ts';

/**
 * Auth-event auditing (Task 5a) — every login, denial, and logout is written to
 * the append-only ledger via the single blessed {@link writeAudit} path (services/
 * audit, Task 5b), with the caller IP (CONTRACTS §C1 `ip`).
 *
 * FRICTION (reported upward): the 5b audit-action catalog defines `auth.login` and
 * `auth.denied` but NOT a logout action, and `writeAudit` validates `action`
 * against that closed enum. `apps/api/src/services/audit/actions.ts` is outside the
 * 5a allowlist, so this module cannot add `auth.logout`. {@link auditLogout}
 * therefore FEATURE-DETECTS the action: it writes the row once `'auth.logout'` is
 * present in `AUDIT_ACTIONS` (a one-line addition for the catalog owner) and
 * otherwise no-ops — logout itself never fails, and the audit lights up with zero
 * further code change. See the task report.
 */

const LOGOUT_ACTION = 'auth.logout';

export interface AuthAuditLoginInput {
  userId: string;
  ip?: string | null;
  /** Non-secret snapshot (email/idpSubject); redaction still runs on write. */
  snapshot?: AuditSnapshot;
}

export async function auditLogin(db: Db, input: AuthAuditLoginInput): Promise<void> {
  await writeAudit(db, {
    action: 'auth.login',
    entity: 'auth',
    entityId: input.userId,
    actorId: input.userId,
    actorType: 'user',
    ip: input.ip ?? null,
    ...(input.snapshot !== undefined ? { after: input.snapshot } : {}),
  });
}

export interface AuthAuditDeniedInput {
  /** Machine reason: 'no_group' | 'inactive' | 'bad_state' | an id-token reason | … */
  reason: string;
  /** Present only when a local user exists (e.g. inactive); absent for group-less. */
  userId?: string | null;
  ip?: string | null;
  snapshot?: AuditSnapshot;
}

export async function auditDenied(db: Db, input: AuthAuditDeniedInput): Promise<void> {
  const userId = input.userId ?? null;
  await writeAudit(db, {
    action: 'auth.denied',
    entity: 'auth',
    entityId: userId,
    actorId: userId,
    actorType: userId !== null ? 'user' : 'system',
    reason: input.reason,
    ip: input.ip ?? null,
    ...(input.snapshot !== undefined ? { after: input.snapshot } : {}),
  });
}

export interface AuthAuditLogoutInput {
  userId: string;
  ip?: string | null;
}

/**
 * Audit a logout. Returns `true` if a row was written, `false` if the catalog does
 * not yet carry `auth.logout` (see the module FRICTION note). Logout's security
 * effect (cookie revocation) is the caller's job and is independent of this.
 */
export async function auditLogout(db: Db, input: AuthAuditLogoutInput): Promise<boolean> {
  if (!(AUDIT_ACTIONS as readonly string[]).includes(LOGOUT_ACTION)) return false;
  await writeAudit(db, {
    action: LOGOUT_ACTION as AuditAction,
    entity: 'auth',
    entityId: input.userId,
    actorId: input.userId,
    actorType: 'user',
    ip: input.ip ?? null,
  });
  return true;
}
