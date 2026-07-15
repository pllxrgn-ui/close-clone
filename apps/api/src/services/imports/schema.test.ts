import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { imports, leads, users, type Db } from '../../db/index.ts';
import { recordActivity } from '../activity/writer.ts';

/** Extract a single `count(*)::int as n` from a raw `db.execute` result. */
function countN(result: unknown): number {
  return (result as { rows: { n: number }[] }).rows[0]?.n ?? -1;
}

/**
 * Task 4f foundation checks: migration 0010 applies on PGlite and the `imports`
 * table matches CONTRACTS §C1, and PGlite supports the nested transaction
 * (savepoint) the committer needs when it drives `ActivityWriter` inside a
 * batch transaction.
 */

const USER = '00000000-0000-4000-8000-0000000000f1';

let ctx: TestDb;

async function seedUser(db: Db): Promise<void> {
  await db.insert(users).values({
    id: USER,
    email: 'importer@example.com',
    name: 'Importer',
    role: 'admin',
    idpSubject: 'idp|importer',
  });
}

beforeEach(async () => {
  ctx = await createTestDb();
  await seedUser(ctx.db);
});

afterEach(async () => {
  await ctx.close();
});

describe('imports table (migration 0010)', () => {
  test('round-trips a row with the C1 columns and defaults', async () => {
    const [row] = await ctx.db
      .insert(imports)
      .values({ createdBy: USER, filename: 'leads.csv', fileRef: '/tmp/leads.csv' })
      .returning();
    expect(row?.status).toBe('uploaded');
    expect(row?.rowCount).toBeNull();
    expect(row?.mapping).toBeNull();
    expect(row?.dryRunResult).toBeNull();
    expect(row?.result).toBeNull();
    expect(row?.createdAt).toBeTruthy();
  });

  test('status column accepts every C1 enum value', async () => {
    for (const status of [
      'uploaded',
      'mapped',
      'dry_run',
      'committing',
      'committed',
      'failed',
    ] as const) {
      const [row] = await ctx.db
        .insert(imports)
        .values({ createdBy: USER, filename: 'f.csv', fileRef: 'r', status })
        .returning();
      expect(row?.status).toBe(status);
    }
  });

  test('created_by FK is enforced (restrict)', async () => {
    await expect(
      ctx.db
        .insert(imports)
        .values({
          createdBy: '00000000-0000-4000-8000-0000000000ff',
          filename: 'f.csv',
          fileRef: 'r',
        }),
    ).rejects.toThrow();
  });
});

describe('PGlite nested transactions (savepoints)', () => {
  test('ActivityWriter.recordActivity runs inside an outer batch transaction', async () => {
    await ctx.db.transaction(async (tx) => {
      const [lead] = await tx
        .insert(leads)
        .values({ id: '11111111-0000-4000-8000-0000000000a1', name: 'Nested Co' })
        .returning();
      expect(lead?.id).toBeTruthy();
      // recordActivity opens its own transaction → a savepoint under `tx`.
      await recordActivity(tx, {
        leadId: '11111111-0000-4000-8000-0000000000a1',
        userId: USER,
        type: 'lead_created',
        occurredAt: new Date().toISOString(),
        payload: {},
      });
    });

    const count = await ctx.db.execute(sql`select count(*)::int as n from activities`);
    expect(countN(count)).toBe(1);
    const denorm = await ctx.db.execute(
      sql`select 1 from ${leads} where id = '11111111-0000-4000-8000-0000000000a1'`,
    );
    expect((denorm as { rows: unknown[] }).rows.length).toBe(1);
  });

  test('a throw inside the outer transaction rolls back the savepoint write too', async () => {
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx
          .insert(leads)
          .values({ id: '11111111-0000-4000-8000-0000000000a2', name: 'Rollback Co' })
          .returning();
        await recordActivity(tx, {
          leadId: '11111111-0000-4000-8000-0000000000a2',
          type: 'lead_created',
          occurredAt: new Date().toISOString(),
          payload: {},
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const count = await ctx.db.execute(sql`select count(*)::int as n from activities`);
    expect(countN(count)).toBe(0);
  });
});
