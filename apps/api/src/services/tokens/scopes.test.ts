import { describe, expect, test } from 'vitest';

import {
  ADMIN_SCOPE,
  API_SCOPES,
  apiScopeSchema,
  hasScope,
  isApiScope,
  parseScopes,
  type ApiScope,
} from './scopes.ts';

/** Task 5c — scope model. Superscope semantics + tolerant jsonb parsing. */

describe('scope catalog', () => {
  test('the union is the documented small set', () => {
    expect([...API_SCOPES]).toEqual(['read:leads', 'write:leads', 'read:reports', 'admin']);
  });

  test('apiScopeSchema accepts members and rejects non-members', () => {
    expect(apiScopeSchema.safeParse('read:leads').success).toBe(true);
    expect(apiScopeSchema.safeParse('delete:everything').success).toBe(false);
  });

  test('isApiScope guards unknown values', () => {
    expect(isApiScope('admin')).toBe(true);
    expect(isApiScope('nope')).toBe(false);
    expect(isApiScope(42)).toBe(false);
    expect(isApiScope(null)).toBe(false);
  });
});

describe('parseScopes (from untyped jsonb)', () => {
  test('keeps known scopes, drops junk, dedupes', () => {
    expect(parseScopes(['read:leads', 'bogus', 'read:leads', 7, 'admin'])).toEqual([
      'read:leads',
      'admin',
    ]);
  });

  test('non-array input → empty', () => {
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes('read:leads')).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe('hasScope', () => {
  test('exact match grants access', () => {
    expect(hasScope(['read:leads'], 'read:leads')).toBe(true);
  });

  test('missing scope is refused', () => {
    expect(hasScope(['read:leads'], 'write:leads')).toBe(false);
    expect(hasScope([], 'read:reports')).toBe(false);
  });

  test('admin is a superscope — satisfies every requirement', () => {
    const admin: ApiScope[] = [ADMIN_SCOPE];
    for (const required of API_SCOPES) {
      expect(hasScope(admin, required)).toBe(true);
    }
  });

  test('a non-admin token does NOT get admin by holding other scopes', () => {
    expect(hasScope(['read:leads', 'write:leads', 'read:reports'], 'admin')).toBe(false);
  });
});
