import Fastify, { type FastifyInstance } from 'fastify';
import { asc } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type AppConfig } from '../config.ts';
import { createTestDb } from '../db/test-helpers.ts';
import { users, type Db } from '../db/index.ts';
import {
  fixturesPresent,
  loadGoldenFixtures,
  type LoadedCounts,
} from '../services/fixtures/loader.ts';
import type { preHandlerHookHandler } from 'fastify';
import { registerRoutes } from '../routes/index.ts';
import { createProviderRegistry, createEmailSenderRegistry } from '../providers/registry.ts';
import { InProcessQueueDriver } from '../queue/index.ts';
import { TokenCipher } from '../services/sync/token-cipher.ts';
import { MockGmailPushVerifier } from '../services/sync/index.ts';
import { SignatureTwilioVerifier } from '../services/telephony/ingress.ts';
import { MOCK_TWILIO_AUTH_TOKEN } from '../providers/telephony/twilio-signature.ts';
import { ImportStorage } from '../services/imports/storage.ts';
import { processIntent } from '../services/sequences/dispatch.ts';
import { SEND_JOB_NAME } from '../services/sequences/job-names.ts';
import { handleTelephonyJob, TWILIO_PROCESS_JOB } from '../services/telephony/worker.ts';
import { registerDevCors } from './cors.ts';
import { registerDevAuthRoutes } from './auth.ts';
import { registerDevReferenceRoutes } from './reference.ts';
import { seedDevSmartViews, type RawQueryable } from './smart-views.ts';
import { resolveCurrentUserId } from './util.ts';
import { loadActiveUser } from '../auth/guards.ts';

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
  /** Import storage override. By default an owned temporary directory is used. */
  importsRoot?: string;
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
  const firstUser = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .orderBy(asc(users.name))
    .limit(1);
  const defaultUserId = firstUser[0]?.id ?? '00000000-0000-4000-8000-000000000000';
  const defaultUserEmail = firstUser[0]?.email ?? 'rep@mock.test';

  const app = Fastify({ logger: false });
  registerDevCors(app, opts.corsOrigins !== undefined ? { origins: opts.corsOrigins } : {});

  // Keep the intentionally open demo reads, but attach a valid dev-login
  // identity so account-scoped routes use the same request context as production.
  app.addHook('preHandler', async (request) => {
    const userId = resolveCurrentUserId(request, config.sessionSecret);
    if (userId === null) return;
    const user = await loadActiveUser(db, userId);
    if (user === null) return;
    request.user = user;
    request.actor = { id: user.id, type: 'user' };
  });

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

  // The FULL real API via `registerRoutes` with MOCK_MODE adapters — this is the
  // whole point: VITE_API_MODE=real runs the web against these real routes (the
  // product CRUD, smart-views, bulk, admin, inbox, sequences), not MSW. The old
  // dev read-shims for leads/lead-detail/smart-views are GONE (superseded — they
  // would collide with the real routes); seedDevSmartViews still seeds the demo
  // views into the real `smart_views` table that the real route reads.
  const gmailCallbackUrl = `http://localhost:${config.port}/api/v1/oauth/gmail/callback`;
  const registry = createProviderRegistry(
    { mockMode: true },
    {
      address: defaultUserEmail,
      authorizationUrl: gmailCallbackUrl,
    },
  );
  if (
    registry.email === undefined ||
    registry.telephony === undefined ||
    registry.asr === undefined ||
    registry.ai === undefined
  ) {
    throw new Error('mock provider registry requires every provider');
  }
  const telephony = registry.telephony;
  const asr = registry.asr;
  const ai = registry.ai;
  const senderRegistry = createEmailSenderRegistry({ mockMode: true });
  const cipher = new TokenCipher(config.sessionSecret);
  const verifier = new MockGmailPushVerifier();
  const queue = new InProcessQueueDriver({ mode: 'timer' });
  const ownsImportsRoot = opts.importsRoot === undefined;
  const importsRoot = opts.importsRoot ?? (await mkdtemp(join(tmpdir(), 'switchboard-imports-')));
  // Dev admin guard: dev-login users are treated as admins (no OIDC in dev).
  const devAdminGuard: preHandlerHookHandler = async () => {};
  registerRoutes(app, {
    db,
    email: {
      db,
      provider: registry.email,
      cipher,
      verifier,
      redirectUri: gmailCallbackUrl,
      stateSecret: config.sessionSecret,
      postLinkRedirect: 'http://localhost:5173/settings?section=inboxes',
      providerName: 'mock',
    },
    emailSend: { providerFor: senderRegistry.providerFor, cipher },
    sequences: { queue, now: () => new Date() },
    smartViews: {
      client,
      orgTimezone: DEV_ORG_TIMEZONE,
      defaultUserId,
      getActor: (request) => (request.user ? { userId: request.user.id } : null),
    },
    bulk: {
      client,
      orgTimezone: DEV_ORG_TIMEZONE,
      queue,
      defaultUserId,
      getActor: (request) => (request.user ? { userId: request.user.id } : null),
    },
    adminCrud: { adminGuard: devAdminGuard },
    inbox: { queue },
    telephony: {
      verifier: new SignatureTwilioVerifier(MOCK_TWILIO_AUTH_TOKEN),
      dialProvider: telephony,
      voicemailProvider: telephony,
      now: () => new Date(),
      publicBaseUrl: `http://localhost:${config.port}`,
      callerId: '+15550000001',
      queue,
      dialerClient: client,
      orgTimezone: DEV_ORG_TIMEZONE,
    },
    sms: {
      provider: telephony,
      now: () => new Date(),
      fromNumber: '+15550000001',
    },
    ai: { asr, ai, now: () => new Date() },
    imports: {
      storage: new ImportStorage(importsRoot),
      getActor: (request) => (request.user ? { userId: request.user.id } : null),
      preHandler: devAdminGuard,
    },
  });

  // The zero-account real-API demo runs the same async behavior as production:
  // enrollment wake-ups send through the mock providers and inbound Twilio jobs
  // materialize on the timeline. Timer mode means no manual test tick is needed.
  const dispatchDeps = {
    db,
    providerFor: senderRegistry.providerFor,
    cipher,
    queue,
    workerId: `dev:${process.pid}`,
    now: () => new Date(),
    unsubscribe: {
      baseUrl: `http://localhost:${config.port}`,
      mailbox: 'unsubscribe@switchboard.test',
      secret: config.sessionSecret,
    },
    sms: { provider: telephony, fromNumber: '+15550000001' },
  };
  queue.process(async (job) => {
    if (job.name === SEND_JOB_NAME) {
      const intentId = job.data['intentId'];
      if (typeof intentId === 'string') await processIntent(dispatchDeps, intentId);
      return;
    }
    if (job.name === TWILIO_PROCESS_JOB) {
      await handleTelephonyJob({ db, provider: telephony }, job);
    }
  });

  // Dev-only shims that are NOT superseded: dev-login (OIDC stub) + reference reads.
  registerDevAuthRoutes(app, { db, sessionSecret: config.sessionSecret });
  registerDevReferenceRoutes(app, { db });

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
      await queue.close();
      await tdb.close();
      if (ownsImportsRoot) await rm(importsRoot, { recursive: true, force: true });
    },
  };
}
