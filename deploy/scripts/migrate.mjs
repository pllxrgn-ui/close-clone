#!/usr/bin/env node
/**
 * Advisory-locked "migrate then exit" runner for the api image entrypoint.
 *
 * Uses drizzle-orm's node-postgres migrator — `drizzle-orm` and `pg` are already
 * production dependencies of @switchboard/api, so the slim runtime needs NO
 * drizzle-kit. It applies the same journal (apps/api/src/db/migrations) that the
 * PGlite test path applies (src/db/test-helpers.ts) — one migration source of
 * truth for both tests and production.
 *
 * Concurrency (single-writer v1, ARCHITECTURE §8): a *session-level* Postgres
 * advisory lock is taken on the one connection used for the whole run, so two
 * booting containers serialise — the second blocks until the first finishes,
 * then finds nothing to do (drizzle records applied migrations in
 * `__drizzle_migrations` and skips them). The lock auto-releases if the process
 * dies mid-migration. This is belt-and-suspenders on top of the design rule that
 * only the `server` role migrates (MIGRATE_ON_BOOT); see deploy/README.md for the
 * honest multi-replica story.
 *
 * Run by deploy/scripts/entrypoint.sh; the Dockerfile copies this next to the
 * api's node_modules so `pg`/`drizzle-orm` resolve.
 */
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Stable 64-bit key so every Switchboard boot contends on the same lock.
const ADVISORY_LOCK_KEY = 4_820_193_476_552_001n;

function migrationsFolder() {
  const fromEnv = process.env.MIGRATIONS_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  // Default assumes this file sits at <api>/migrate.mjs (Dockerfile layout).
  return resolve(dirname(fileURLToPath(import.meta.url)), 'src/db/migrations');
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    console.error('[migrate] DATABASE_URL is required');
    process.exit(1);
  }

  const folder = migrationsFolder();
  const client = new pg.Client({ connectionString });
  await client.connect();

  let locked = false;
  try {
    // C3: pin the session to UTC (harmless for DDL; keeps parity with runtime).
    await client.query("SET TIME ZONE 'UTC'");
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY.toString()]);
    locked = true;
    console.log(`[migrate] lock acquired; applying migrations from ${folder}`);

    const db = drizzle(client);
    await migrate(db, { migrationsFolder: folder });

    console.log('[migrate] up to date');
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY.toString()]);
      } catch (err) {
        console.error('[migrate] advisory unlock failed (lock auto-releases on disconnect)', err);
      }
    }
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED', err);
  process.exit(1);
});
