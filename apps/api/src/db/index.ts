import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * Database module barrel. Re-exports the full Drizzle schema and a driver-
 * agnostic `Db` type so services (ActivityWriter, fixture loader) accept either
 * PGlite (tests) or node-postgres (real PG, the latency gate) without a compile
 * branch — both are `PgDatabase` subtypes.
 */

export * from './schema.ts';

/**
 * A Drizzle Postgres handle usable across drivers. Concrete driver databases
 * (`PgliteDatabase`, `NodePgDatabase`) are assignable to this; the generic
 * result-HKT keeps it driver-neutral.
 */
export type Db = PgDatabase<PgQueryResultHKT>;
