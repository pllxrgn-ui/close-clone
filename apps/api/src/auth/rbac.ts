import type { Role } from './types.ts';

/**
 * Group-based RBAC (Task 5a, build guide §1: no local roles — the IdP is the
 * authority). Two groups gate the app; membership maps to exactly one role, and
 * anyone in neither is refused login entirely (there is no "authenticated but
 * role-less" state). `admin` ⊃ `rep`, so a user in both groups is an admin.
 */

export const SALES_CRM_ADMINS_GROUP = 'sales-crm-admins';
export const SALES_CRM_USERS_GROUP = 'sales-crm-users';

/**
 * Map IdP group claims to a Switchboard role, or `null` if the user is in neither
 * gating group (→ login refused, audited `auth.denied`). Role is recomputed from
 * groups on every login, so removing someone from the admins group demotes them
 * on their next sign-in.
 */
export function groupsToRole(groups: readonly string[] | undefined): Role | null {
  if (groups === undefined) return null;
  if (groups.includes(SALES_CRM_ADMINS_GROUP)) return 'admin';
  if (groups.includes(SALES_CRM_USERS_GROUP)) return 'rep';
  return null;
}
