import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { auditLog, users } from '../db/index.ts';
import { AUDIT_ACTIONS } from '../services/audit/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { auditDenied, auditLogin, auditLogout } from './auth-audit.ts';

/** Task 5a — auth-event auditing through the blessed writeAudit path. */

const USER = '00000000-0000-4000-8000-0000000000c1';

let ctx: TestDb;

beforeEach(async () => {
  ctx = await createTestDb();
  // audit_log.actor_id FKs users.id — seed the actor (in real flows the user
  // exists before any auth.login / inactive-denial is written).
  await ctx.db.insert(users).values({
    id: USER,
    email: 'c1@corp.test',
    name: 'C One',
    role: 'rep',
    idpSubject: 'idp|c1',
  });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('auditLogin', () => {
  test('writes an auth.login row with actor + ip', async () => {
    await auditLogin(ctx.db, { userId: USER, ip: '203.0.113.7', snapshot: { role: 'rep' } });
    const rows = await ctx.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('auth.login');
    expect(rows[0]?.actorId).toBe(USER);
    expect(rows[0]?.actorType).toBe('user');
    expect(rows[0]?.ip).toBe('203.0.113.7');
  });
});

describe('auditDenied', () => {
  test('group-less: system actor, no user id, carries reason', async () => {
    await auditDenied(ctx.db, {
      reason: 'no_group',
      ip: '203.0.113.9',
      snapshot: { idpSubject: 'google|x', email: 'x@corp.test' },
    });
    const [row] = await ctx.db.select().from(auditLog);
    expect(row?.action).toBe('auth.denied');
    expect(row?.actorId).toBeNull();
    expect(row?.actorType).toBe('system');
    expect(row?.reason).toBe('no_group');
  });

  test('inactive: user actor with the id', async () => {
    await auditDenied(ctx.db, { reason: 'inactive', userId: USER, ip: '203.0.113.9' });
    const [row] = await ctx.db.select().from(auditLog);
    expect(row?.actorId).toBe(USER);
    expect(row?.actorType).toBe('user');
    expect(row?.reason).toBe('inactive');
  });
});

describe('auditLogout (catalog-gap feature-detect)', () => {
  test('reflects whether auth.logout exists in the audit catalog', async () => {
    const catalogHasLogout = (AUDIT_ACTIONS as readonly string[]).includes('auth.logout');
    const wrote = await auditLogout(ctx.db, { userId: USER, ip: '203.0.113.1' });
    expect(wrote).toBe(catalogHasLogout);
    const rows = await ctx.db.select().from(auditLog);
    // A row exists iff the catalog carries the action; logout still succeeds either way.
    expect(rows.length).toBe(catalogHasLogout ? 1 : 0);
  });
});
