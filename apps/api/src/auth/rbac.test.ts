import { describe, expect, test } from 'vitest';

import { groupsToRole, SALES_CRM_ADMINS_GROUP, SALES_CRM_USERS_GROUP } from './rbac.ts';

/** Task 5a — group → role mapping. */

describe('groupsToRole', () => {
  test('admins group → admin', () => {
    expect(groupsToRole([SALES_CRM_ADMINS_GROUP])).toBe('admin');
  });
  test('users group → rep', () => {
    expect(groupsToRole([SALES_CRM_USERS_GROUP])).toBe('rep');
  });
  test('both groups → admin (admin ⊃ rep)', () => {
    expect(groupsToRole([SALES_CRM_USERS_GROUP, SALES_CRM_ADMINS_GROUP])).toBe('admin');
  });
  test('neither group → null (login refused)', () => {
    expect(groupsToRole(['some-other-group'])).toBeNull();
    expect(groupsToRole([])).toBeNull();
  });
  test('undefined groups claim → null', () => {
    expect(groupsToRole(undefined)).toBeNull();
  });
});
