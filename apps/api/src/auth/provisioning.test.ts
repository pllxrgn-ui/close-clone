import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';

import { users } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { provisionUser } from './provisioning.ts';

/** Task 5a — JIT provisioning keyed on idp_subject (CONTRACTS §C1). */

let ctx: TestDb;

beforeEach(async () => {
  ctx = await createTestDb();
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('provisionUser', () => {
  test('new subject → provisioned active with the given role', async () => {
    const res = await provisionUser(ctx.db, {
      idpSubject: 'google|new',
      email: 'new@corp.test',
      name: 'New Rep',
      role: 'rep',
    });
    expect(res.status).toBe('ok');
    expect(res.user.role).toBe('rep');
    expect(res.user.isActive).toBe(true);
    expect(res.user.email).toBe('new@corp.test');
  });

  test('same subject twice → one row, updated in place (no duplicate)', async () => {
    const first = await provisionUser(ctx.db, {
      idpSubject: 'google|dup',
      email: 'dup@corp.test',
      name: 'First',
      role: 'rep',
    });
    const second = await provisionUser(ctx.db, {
      idpSubject: 'google|dup',
      email: 'dup@corp.test',
      name: 'Renamed',
      role: 'admin', // promoted in the IdP
    });
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.name).toBe('Renamed');
    expect(second.user.role).toBe('admin'); // groups are authoritative for role
    const all = await ctx.db.select().from(users).where(eq(users.idpSubject, 'google|dup'));
    expect(all).toHaveLength(1);
  });

  test('existing inactive user → status inactive, row untouched', async () => {
    await ctx.db.insert(users).values({
      email: 'gone@corp.test',
      name: 'Deactivated',
      role: 'rep',
      idpSubject: 'google|inactive',
      isActive: false,
    });
    const res = await provisionUser(ctx.db, {
      idpSubject: 'google|inactive',
      email: 'changed@corp.test',
      name: 'Changed',
      role: 'admin',
    });
    expect(res.status).toBe('inactive');
    // Not resurrected, not modified.
    const [row] = await ctx.db.select().from(users).where(eq(users.idpSubject, 'google|inactive'));
    expect(row?.isActive).toBe(false);
    expect(row?.name).toBe('Deactivated');
    expect(row?.email).toBe('gone@corp.test');
  });
});
