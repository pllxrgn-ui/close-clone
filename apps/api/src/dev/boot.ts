import Fastify, { type FastifyInstance } from 'fastify';
import { asc } from 'drizzle-orm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type AppConfig } from '../config.ts';
import { createTestDb } from '../db/test-helpers.ts';
import { users, type Db } from '../db/index.ts';
import {
  fixturesPresent,
  loadGoldenFixtures,
  type LoadedCounts,
} from '../services/fixtures/loader.ts';
import { registerRoutes } from '../routes/index.ts';
import { createProviderRegistry, createEmailSenderRegistry } from '../providers/registry.ts';
import { TokenCipher } from '../services/sync/token-cipher.ts';
import { MockGmailPushVerifier } from '../services/sync/index.ts';
import { registerDevCors } from './cors.ts';
import { registerDevAuthRoutes } from './auth.ts';
import { registerDevReferenceRoutes } from './reference.ts';
import { registerDevLeadRoutes } from './leads.ts';
import { registerDevLeadDetailRoutes } from './lead-detail.ts';
import { registerDevSmartViewRoutes, seedDevSmartViews, type RawQueryable } from './smart-views.ts';

/**
 * Dev-server composition root (DEV-ONLY). Boots embedded PGlite (real Postgres
 * semantics, D-003), runs the C1 migrations, loads the 5k golden fixture, binds
 * the MOCK_MODE providers, and mounts EVERY existing route plugin (via the real
 * `registerRoutes`) plus the dev-login + reference + leads + smart-view shims the
 * web needs. It reuses `createTestDb` (the canonical PGlite + migrate helper) so
 * there is exactly one migration path in the repo.
 *
 * `buildDevServer` is import-safe and returns the wired app + handles, so the
 * smoke test can boot the whole thing in-process with `app.inject` — no port.
 */

/** Org timezone for relative-date resolution in smart-view previews (C3). */
const DEV_ORG_TIMEZONE = 'America/New_York';

/** Default golden fixture dir (matches the loader's own default resolution). */
const GOLDEN_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'fixtures/out/golden',
);

/** Actionable message when the (gitignored) golden fixture has not been built. */
function fixturesMissingMessage(dir: string): string {
  return (
    `golden fixture not found at ${dir}. Generate it first (it is gitignored):\n` +
    `  node --experimental-strip-types fixtures/src/cli.ts --golden\n` +
    `  (or, on Node >= 23: pnpm --filter @switchboard/fixtures run generate:golden)`
  );
}

export interface BuildDevServerOptions {
  config?: AppConfig;
  /** Skip the golden fixture load (fast boot for narrow tests). Default: load. */
  loadFixtures?: boolean;
  /** Extra CORS origins beyond the Vite dev defaults. */
  corsOrigins?: readonly string[];
}

export interface DevServerTimings {
  migrateMs: number;
  loadMs: number;
  seedMs: number;
  totalMs: number;
}

export interface DevServer {
  app: FastifyInstance;
  db: Db;
  client: RawQueryable & { close: () => Promise<void> };
  config: AppConfig;
  counts: LoadedCounts | null;
  timings: DevServerTimings;
  /** Shut down Fastify and the embedded database. */
  close: () => Promise<void>;
}

export async function buildDevServer(opts: BuildDevServerOptions = {}): Promise<DevServer> {
  const config = opts.config ?? loadConfig();
  const t0 = Date.now();

  // Embedded Postgres + C1 migrations (reused from the test-helpers boot path).
  const tdb = await createTestDb();
  const db = tdb.db;
  const client = tdb.client as unknown as RawQueryable & { close: () => Promise<void> };
  // C3: every DB session runs UTC; date-only DSL literals anchor at UTC midnight.
  await tdb.client.exec(`SET TIME ZONE 'UTC'`);
  const tMigrated = Date.now();

  // Golden fixture (deterministic; same content hash every boot).
  let counts: LoadedCounts | null = null;
  if (opts.loadFixtures !== false) {
    if (!fixturesPresent(GOLDEN_DIR, 'json')) {
      await tdb.close();
      throw new Error(fixturesMissingMessage(GOLDEN_DIR));
    }
    counts = await loadGoldenFixtures(db);
  }
  const tLoaded = Date.now();

  // Seed the demo smart views (idempotent, deterministic ids/timestamps).
  await seedDevSmartViews(db);
  const tSeeded = Date.now();

  // `me` fallback for previews with no dev session: a real fixture owner.
  const firstUser = await db.select({ id: users.id }).from(users).orderBy(asc(users.id)).limit(1);
  const defaultUserId = firstUser[0]?.id ?? '00000000-0000-4000-8000-000000000000';

  const app = Fastify({ logger: false });
  registerDevCors(app, opts.corsOrigins !== undefined ? { origins: opts.corsOrigins } : {});

  // Liveness + dev info.
  app.get('/healthz', async () => ({
    ok: true,
    checks: { db: 'up', mode: config.mockMode ? 'mock' : 'real' },
  }));
  app.get('/api/v1/dev/ping', async () => ({
    ok: true,
    mode: config.mockMode ? 'mock' : 'real',
    fixtures: counts,
    orgTimezone: DEV_ORG_TIMEZONE,
  }));

  // Every existing route plugin, wired with MOCK_MODE adapters (the real
  // composition path via `registerRoutes`): search, triage, templates, snippets,
  // threads (DB-only) + email sync/send (mock provider, cipher, push verifier).
  const registry = createProviderRegistry({ mockMode: true });
  const senderRegistry = createEmailSenderRegistry({ mockMode: true });
  const cipher = new TokenCipher(config.sessionSecret);
  const verifier = new MockGmailPushVerifier();
  registerRoutes(app, {
    db,
    email: {
      db,
      provider: registry.email,
      cipher,
      verifier,
      redirectUri: `http://localhost:${config.port}/api/v1/oauth/gmail/callback`,
      providerName: 'mock',
    },
    emailSend: { providerFor: senderRegistry.providerFor, cipher },
  });

  // Dev-only shims (open reads; dev-login supplies `me`).
  registerDevAuthRoutes(app, { db, sessionSecret: config.sessionSecret });
  registerDevReferenceRoutes(app, { db });
  registerDevLeadRoutes(app, { db });
  registerDevLeadDetailRoutes(app, { db });
  registerDevSmartViewRoutes(app, {
    db,
    client,
    sessionSecret: config.sessionSecret,
    defaultUserId,
    orgTimezone: DEV_ORG_TIMEZONE,
  });

  await app.ready();
  const totalMs = Date.now() - t0;

  return {
    app,
    db,
    client,
    config,
    counts,
    timings: {
      migrateMs: tMigrated - t0,
      loadMs: tLoaded - tMigrated,
      seedMs: tSeeded - tLoaded,
      totalMs,
    },
    close: async () => {
      await app.close();
      await tdb.close();
    },
  };
}
