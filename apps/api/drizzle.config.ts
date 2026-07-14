import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config (Task 1a). Generates real SQL migrations from
 * `src/db/schema.ts` into `src/db/migrations`. The `citext`/`pgcrypto`
 * extensions are enabled by the hand-authored bootstrap migration that the
 * journal orders first; drizzle-kit's generated migration follows it.
 *
 * `dbCredentials.url` is only consulted by `drizzle-kit push/migrate/studio`
 * (real Postgres); `generate` needs no live connection. Tests apply migrations
 * on PGlite via `src/db/test-helpers.ts`, not this config.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://switchboard:switchboard@localhost:5432/switchboard',
  },
  strict: true,
  verbose: false,
});
