import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ephemeral in-process Postgres for unit/property tests (DECISIONS D-003:
 * PGlite = real Postgres semantics via WASM, no Docker). Spins a fresh DB and
 * runs the Drizzle migrations from `./migrations` (empty for now — schema lands
 * in Phase 1). The latency gate (Task 1c) uses real Postgres, not this.
 */

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface TestDb {
  db: PgliteDatabase;
  client: PGlite;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
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
