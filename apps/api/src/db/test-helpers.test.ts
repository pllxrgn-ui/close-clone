import { expect, test } from 'vitest';
import { createTestDb } from './test-helpers.ts';

test('createTestDb boots PGlite, runs (empty) migrations, and serves queries', async () => {
  const { client, close } = await createTestDb();
  try {
    const result = await client.query<{ one: number }>('select 1 as one');
    expect(result.rows[0]?.one).toBe(1);

    // migrate() bootstraps the drizzle migrations bookkeeping table even with
    // zero migrations — proves the migrator ran end to end.
    const migrations = await client.query(
      "select 1 from information_schema.tables where table_schema = 'drizzle'",
    );
    expect(migrations.rows.length).toBeGreaterThanOrEqual(1);
  } finally {
    await close();
  }
}, 120_000);
// 120s (not the 5s default): since migration 0003 the chain loads the pg_trgm
// contrib extension and builds GIN trigram indexes, which under the full parallel
// suite can exceed 5s from CPU contention (isolated cost is ~1s). Matches the
// timeout the other DB-backed suites already use.
