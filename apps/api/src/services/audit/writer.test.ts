import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { auditLog, suppressions, users } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { REDACTED } from './redaction.ts';
import {
  AuditWriter,
  MissingReasonError,
  releaseSuppression,
  requestActor,
  SuppressionAlreadyReleasedError,
  SuppressionNotFoundError,
  writeAudit,
  type AuditLogRow,
} from './writer.ts';

/**
 * Task 5b — AuditWriter + the append-only DB guarantee + the blessed
 * suppression-release path.
 *
 * `createTestDb` applies migrations 0000 → 0011; the suite booting proves the
 * chain (incl. migration 0011's trigger) applies clean from an empty database.
 */

let ctx: TestDb;

beforeEach(async () => {
  ctx = await createTestDb();
});

afterEach(async () => {
  await ctx.close();
});

async function seedUser(suffix = 'a', role: 'rep' | 'admin' = 'admin'): Promise<string> {
  const [u] = await ctx.db
    .insert(users)
    .values({
      email: `user-${suffix}@x.test`,
      name: `U${suffix}`,
      role,
      idpSubject: `idp-${suffix}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error('seed user failed');
  return u.id;
}

async function seedSuppression(): Promise<string> {
  const [s] = await ctx.db
    .insert(suppressions)
    .values({ kind: 'email', value: 'blocked@x.test', source: 'bounce' })
    .returning({ id: suppressions.id });
  if (!s) throw new Error('seed suppression failed');
  return s.id;
}

async function countAudit(): Promise<number> {
  const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
  return row?.n ?? 0;
}

async function fetchAudit(id: string): Promise<AuditLogRow> {
  const [row] = await ctx.db.select().from(auditLog).where(eq(auditLog.id, id));
  if (!row) throw new Error('audit row not found');
  return row;
}

describe('writeAudit basics', () => {
  test('appends one row with the given fields', async () => {
    const actor = await seedUser();
    const row = await writeAudit(ctx.db, {
      action: 'auth.login',
      entity: 'auth',
      actorType: 'user',
      actorId: actor,
      ip: '203.0.113.7',
    });
    expect(row.action).toBe('auth.login');
    expect(row.entity).toBe('auth');
    expect(row.actorType).toBe('user');
    expect(row.actorId).toBe(actor);
    expect(row.ip).toBe('203.0.113.7');
    expect(row.at).not.toBeNull();
    expect(await countAudit()).toBe(1);
  });

  test('honours an explicit `at` override', async () => {
    await writeAudit(ctx.db, {
      action: 'import.committed',
      entity: 'import',
      actorType: 'system',
      at: '2026-01-02T03:04:05.000Z',
    });
    const [row] = await ctx.db.select().from(auditLog);
    expect(new Date(row!.at).toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  test('rejects an action outside the catalog, writing nothing', async () => {
    await expect(
      // @ts-expect-error — 'bogus.action' is not an AuditAction.
      writeAudit(ctx.db, { action: 'bogus.action', entity: 'user', actorType: 'system' }),
    ).rejects.toThrow();
    expect(await countAudit()).toBe(0);
  });

  test('rejects a non-uuid entityId, writing nothing', async () => {
    await expect(
      writeAudit(ctx.db, {
        action: 'admin.user_changed',
        entity: 'user',
        entityId: 'not-a-uuid',
        actorType: 'system',
      }),
    ).rejects.toThrow();
    expect(await countAudit()).toBe(0);
  });

  test('redacts credential material in before/after AT WRITE TIME', async () => {
    const row = await writeAudit(ctx.db, {
      action: 'admin.compliance_switch_changed',
      entity: 'email_account',
      actorType: 'user',
      before: { address: 'box@x.test', oauthTokens: 'ya29.OLD' },
      after: { address: 'box@x.test', oauthTokens: 'ya29.NEW', accessToken: 'live' },
    });
    const stored = await fetchAudit(row.id);
    expect(stored.before).toEqual({ address: 'box@x.test', oauthTokens: REDACTED });
    expect(stored.after).toEqual({
      address: 'box@x.test',
      oauthTokens: REDACTED,
      accessToken: REDACTED,
    });
  });
});

describe('append-only DB trigger (migration 0011)', () => {
  test('UPDATE on audit_log is rejected and the row survives', async () => {
    const row = await writeAudit(ctx.db, {
      action: 'auth.login',
      entity: 'auth',
      actorType: 'system',
    });
    await expect(
      ctx.client.query(`UPDATE audit_log SET reason = 'tamper' WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/append-only/);
    // Row unchanged.
    expect((await fetchAudit(row.id)).reason).toBeNull();
    expect(await countAudit()).toBe(1);
  });

  test('DELETE on audit_log is rejected and the row survives', async () => {
    const row = await writeAudit(ctx.db, {
      action: 'auth.login',
      entity: 'auth',
      actorType: 'system',
    });
    await expect(ctx.client.query(`DELETE FROM audit_log WHERE id = $1`, [row.id])).rejects.toThrow(
      /append-only/,
    );
    expect(await countAudit()).toBe(1);
  });

  test('TRUNCATE audit_log is rejected', async () => {
    await writeAudit(ctx.db, { action: 'auth.login', entity: 'auth', actorType: 'system' });
    await expect(ctx.client.query(`TRUNCATE audit_log`)).rejects.toThrow(/append-only/);
    expect(await countAudit()).toBe(1);
  });

  test('the ORM update path is blocked too', async () => {
    const row = await writeAudit(ctx.db, {
      action: 'auth.login',
      entity: 'auth',
      actorType: 'system',
    });
    await expect(
      ctx.db.update(auditLog).set({ reason: 'x' }).where(eq(auditLog.id, row.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }),
    });
  });
});

describe('transactional co-commit (audit inside a caller txn)', () => {
  test('a caller rollback discards the audit row it wrote in the same txn', async () => {
    await expect(
      ctx.db.transaction(async (tx) => {
        await writeAudit(tx, {
          action: 'delete.hard_completed',
          entity: 'lead',
          actorType: 'system',
        });
        // Simulate the caller's own work failing after the audit write.
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The audit row rolled back with the caller.
    expect(await countAudit()).toBe(0);
  });

  test('a committed caller txn persists the audit row', async () => {
    await ctx.db.transaction(async (tx) => {
      await writeAudit(tx, {
        action: 'delete.hard_completed',
        entity: 'lead',
        actorType: 'system',
      });
    });
    expect(await countAudit()).toBe(1);
  });
});

describe('AuditWriter wrapper', () => {
  test('write() appends against the bound handle', async () => {
    const writer = new AuditWriter(ctx.db);
    await writer.write({ action: 'export.started', entity: 'export', actorType: 'user' });
    expect(await countAudit()).toBe(1);
  });

  test('write(input, tx) appends inside a passed transaction', async () => {
    const writer = new AuditWriter(ctx.db);
    await ctx.db.transaction(async (tx) => {
      await writer.write({ action: 'export.completed', entity: 'export', actorType: 'user' }, tx);
    });
    expect(await countAudit()).toBe(1);
  });
});

describe('requestActor helper', () => {
  test('infers user when an actor id is present', () => {
    expect(requestActor({ ip: '1.2.3.4' }, { id: 'u1' })).toEqual({
      actorId: 'u1',
      actorType: 'user',
      ip: '1.2.3.4',
    });
  });

  test('infers system when there is no actor', () => {
    expect(requestActor({ ip: null })).toEqual({ actorId: null, actorType: 'system', ip: null });
  });

  test('honours an explicit api_token actor and missing ip', () => {
    expect(requestActor({}, { id: 't1', type: 'api_token' })).toEqual({
      actorId: 't1',
      actorType: 'api_token',
      ip: null,
    });
  });
});

describe('releaseSuppression — the blessed path (§4.5)', () => {
  test('releases with a reason and writes the audit row in the same txn', async () => {
    const actor = await seedUser();
    const suppressionId = await seedSuppression();

    const { suppression, audit } = await releaseSuppression(ctx.db, {
      suppressionId,
      reason: 'contact re-consented via signed form #4471',
      actorId: actor,
      ip: '203.0.113.9',
    });

    // Suppression is released with the C1 released_* fields set.
    expect(suppression.releasedAt).not.toBeNull();
    expect(suppression.releasedBy).toBe(actor);
    expect(suppression.releaseReason).toBe('contact re-consented via signed form #4471');

    // Exactly one audit row, co-committed, with before/after snapshots.
    expect(await countAudit()).toBe(1);
    expect(audit.action).toBe('admin.suppression_released');
    expect(audit.entity).toBe('suppression');
    expect(audit.entityId).toBe(suppressionId);
    expect(audit.actorId).toBe(actor);
    expect(audit.reason).toBe('contact re-consented via signed form #4471');
    expect((audit.before as Record<string, unknown>).releasedAt).toBeNull();
    expect((audit.after as Record<string, unknown>).releasedAt).not.toBeNull();
  });

  test('a blank reason is rejected and nothing changes', async () => {
    const suppressionId = await seedSuppression();
    await expect(
      releaseSuppression(ctx.db, { suppressionId, reason: '   ' }),
    ).rejects.toBeInstanceOf(MissingReasonError);

    const [row] = await ctx.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.id, suppressionId));
    expect(row!.releasedAt).toBeNull();
    expect(await countAudit()).toBe(0);
  });

  test('an unknown suppression id throws SuppressionNotFoundError', async () => {
    await expect(
      releaseSuppression(ctx.db, {
        suppressionId: '00000000-0000-4000-8000-0000000000ff',
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(SuppressionNotFoundError);
    expect(await countAudit()).toBe(0);
  });

  test('a second release throws SuppressionAlreadyReleasedError and writes no new audit', async () => {
    const suppressionId = await seedSuppression();
    await releaseSuppression(ctx.db, { suppressionId, reason: 'first' });
    await expect(
      releaseSuppression(ctx.db, { suppressionId, reason: 'second' }),
    ).rejects.toBeInstanceOf(SuppressionAlreadyReleasedError);
    // Still just the one release audit row.
    expect(await countAudit()).toBe(1);
  });
});
