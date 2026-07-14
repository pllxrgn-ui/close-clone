import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ephemeral in-process Postgres for unit/property tests (DECISIONS D-003:
 * PGlite = real Postgres semantics via WASM, no Docker). Spins a fresh DB and
 * runs the Drizzle migrations from `./migrations` (bootstrap extensions +
 * the C1 schema). The latency gate (Task 1c) uses real Postgres, not this.
 */

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface TestDb {
  db: PgliteDatabase;
  client: PGlite;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  // Register the citext + pg_trgm contrib extensions so the migrations'
  // `CREATE EXTENSION` statements resolve (real Postgres ships both in contrib;
  // PGlite needs the module handed to the constructor — see the empirical note in
  // migration 0003). citext → 0000 bootstrap; pg_trgm → 0003 global search.
  const client = new PGlite({ extensions: { citext, pg_trgm } });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder });
  return {
    db,
    client,
    close: async () => {
      await client.close();
    },
  };
}
