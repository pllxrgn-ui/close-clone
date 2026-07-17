import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { Queue } from 'bullmq';

import { loadConfig, type AppConfig } from './config.ts';
import type { Db } from './db/index.ts';
import { registerRoutes } from './routes/index.ts';
import { createProviderRegistry, createEmailSenderRegistry } from './providers/registry.ts';
import { createBullmqQueueDriver } from './queue/index.ts';
import type { QueueDriver } from './queue/index.ts';
import { TokenCipher } from './services/sync/token-cipher.ts';
import { MockGmailPushVerifier } from './services/sync/index.ts';
import { ImportStorage } from './services/imports/storage.ts';
import { sweepDueIntents } from './services/sequences/sweeper.ts';
import {
  buildLogController,
  buildLoggerOptions,
  createErrorSinkFromConfig,
  createGracefulShutdown,
  genRequestId,
  registerHealthz,
  registerHttpObservability,
  registerSecurityHeaders,
} from './observability/index.ts';
import { requireAdmin, requireSession } from './auth/guards.ts';
import type { SessionReader } from './auth/types.ts';
import { registerDevAuthRoutes } from './dev/auth.ts';
import { resolveCurrentUserId } from './dev/util.ts';

/**
 * THE PRODUCTION COMPOSITION ROOT (deploy/WIRING.md).
 *
 * `server.ts` is a test/embedded helper: no auth, stub healthz, no workers. This
 * is the entry the container actually runs — the one place that owns real
 * config, a real pg pool, real Redis, and the security posture:
 *
 *   - migrations on boot behind a Postgres advisory lock (single-writer safe
 *     across replicas), gated by MIGRATE_ON_BOOT
 *   - a GLOBAL `requireSession` preHandler over /api/v1/* with the documented
 *     exemptions (/wh/*, public unsubscribe, /healthz, dev-login in MOCK_MODE)
 *     — review finding F4
 *   - `requireAdmin` threaded into every admin surface AND the import routes
 *     (bulk write) — review finding F4
 *   - real `/healthz` probing Postgres + BullMQ queue depth
 *   - structured logging with request ids + secret redaction, an error sink,
 *     and graceful shutdown that drains then closes pg + queue
 *   - the sequence worker: queue processor + due-intent sweeper
 *
 * MOCK_MODE branches ONLY here, at the adapter line: the session reader, the
 * provider registry, and the auth issuer are chosen once and injected. Nothing
 * above this file knows which mode it is in.
 */

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'db/migrations');

/** Advisory-lock key for the boot migrator (any stable 64-bit constant). */
const MIGRATION_LOCK_KEY = 4_017_755_301_882_113n;

/** How often the sweeper enqueues due send-intents. */
const SWEEP_INTERVAL_MS = 15_000;

/** A CLAIMED intent older than this is expired to FAILED_TIMEOUT by the sweeper. */
const CLAIM_TIMEOUT_MS = 5 * 60_000;

export type AppRole = 'server' | 'worker';

export interface BuiltApp {
  app: FastifyInstance;
  db: Db;
  queue: QueueDriver;
  close: () => Promise<void>;
}

function readRole(env: NodeJS.ProcessEnv): AppRole {
  return env['APP_ROLE'] === 'worker' ? 'worker' : 'server';
}

/**
 * Run pending migrations under an advisory lock so concurrent replicas cannot
 * race the same DDL: the loser blocks, then finds nothing to do.
 */
export async function migrateOnBoot(db: Db): Promise<void> {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  try {
    await migrate(db as never, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  }
}

/**
 * The session seam (auth/types.ts): real mode reads the OIDC session cookie;
 * MOCK_MODE reads the dev-login cookie/bearer. Both feed the SAME guards.
 */
function buildSessionReader(config: AppConfig): SessionReader {
  if (config.mockMode) {
    return (request) => {
      const userId = resolveCurrentUserId(request, config.sessionSecret);
      return userId === null ? null : { userId };
    };
  }
  // Real mode: the OIDC session cookie codec. Wired when OIDC config lands
  // (HUMAN_TODO: OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET) — see assertRealModeConfig,
  // which refuses to boot rather than silently leaving the API unauthenticated.
  throw new Error('real-mode session reader requires OIDC configuration');
}

/**
 * Fail closed. A production boot without an IdP would otherwise serve the whole
 * API with no way to authenticate anyone — refuse instead.
 */
export function assertRealModeConfig(config: AppConfig, env: NodeJS.ProcessEnv): void {
  if (config.mockMode) return;
  const missing = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'].filter(
    (key) => (env[key] ?? '').trim() === '',
  );
  if (missing.length > 0) {
    throw new Error(
      `MOCK_MODE=0 requires company IdP config: ${missing.join(', ')} unset. ` +
        'Set them (HUMAN_TODO.md → "Company IdP OIDC app") or run MOCK_MODE=1.',
    );
  }
}

export interface BuildOptions {
  config?: AppConfig;
  env?: NodeJS.ProcessEnv;
}

export async function buildProductionApp(options: BuildOptions = {}): Promise<BuiltApp> {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig(env);
  assertRealModeConfig(config, env);

  // ── Real Postgres ─────────────────────────────────────────────────────────
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool) as unknown as Db;
  if (env['MIGRATE_ON_BOOT'] !== '0') await migrateOnBoot(db);

  // ── Real Redis / BullMQ ───────────────────────────────────────────────────
  const redis = new URL(config.redisUrl);
  const connection = {
    host: redis.hostname,
    port: Number(redis.port || 6379),
    ...(redis.password !== '' ? { password: redis.password } : {}),
  };
  const queue = createBullmqQueueDriver({ connection });
  // A second handle purely for depth introspection (the driver hides its queue).
  const probeQueue = new Queue('sequences', { connection });

  // ── Providers ─────────────────────────────────────────────────────────────
  const registry = createProviderRegistry({ mockMode: config.mockMode });
  const senderRegistry = createEmailSenderRegistry({ mockMode: config.mockMode });
  const cipher = new TokenCipher(config.sessionSecret);

  // buildLoggerOptions (not `logger: true`): it carries the req/res/err
  // serializers AND the redact paths, so secrets never reach stdout. The
  // observability plugin owns request logging, so pino's own is disabled via
  // the logController seam (not the deprecated top-level flag).
  const app = Fastify({
    logger: buildLoggerOptions({ level: env['LOG_LEVEL'] ?? 'info' }),
    logController: buildLogController(),
    // Propagates an inbound x-request-id when it is safe, else mints one.
    genReqId: genRequestId,
  });
  registerSecurityHeaders(app);
  registerHttpObservability(app);

  // DSN-gated: a real sink when SENTRY_DSN is set, console otherwise. The C8
  // response mapping is untouched — this only observes.
  const errorSink = createErrorSinkFromConfig({
    ...(env['SENTRY_DSN'] !== undefined ? { dsn: env['SENTRY_DSN'] } : {}),
    ...(env['APP_VERSION'] !== undefined ? { release: env['APP_VERSION'] } : {}),
  });
  app.addHook('onError', async (request, _reply, error) => {
    errorSink.captureException(error, { requestId: String(request.id), route: request.url });
  });

  // ── Real healthz: Postgres + queue depth (replaces server.ts's stub) ──────
  registerHealthz(app, {
    db,
    queueDepth: {
      depth: async () => {
        const counts = await probeQueue.getJobCounts('waiting', 'delayed', 'active');
        return (counts['waiting'] ?? 0) + (counts['delayed'] ?? 0) + (counts['active'] ?? 0);
      },
    },
  });

  // ── Auth (F4): one global gate over /api/v1/*, with the documented exemptions
  const readSession = buildSessionReader(config);
  const sessionGuard = requireSession({ db, readSession });
  const adminGuard: preHandlerHookHandler = requireAdmin({ db, readSession });

  const EXEMPT = (url: string): boolean =>
    url.startsWith('/wh/') ||
    url.startsWith('/healthz') ||
    url.startsWith('/api/v1/unsubscribe') ||
    (config.mockMode && url.startsWith('/api/v1/auth/dev-'));

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/')) return;
    if (EXEMPT(request.url)) return;
    await sessionGuard.call(app, request, reply, () => undefined);
  });

  if (config.mockMode) {
    registerDevAuthRoutes(app, { db, sessionSecret: config.sessionSecret });
  }

  registerRoutes(app, {
    db,
    emailSend: { providerFor: senderRegistry.providerFor, cipher },
    sequences: { queue, now: () => new Date() },
    unsubscribe: { secret: env['LIST_UNSUBSCRIBE_SECRET'] ?? config.sessionSecret },
    email: {
      db,
      provider: registry.email,
      cipher,
      verifier: new MockGmailPushVerifier(),
      redirectUri: `${env['PUBLIC_WEBHOOK_URL'] ?? ''}/api/v1/oauth/gmail/callback`,
      providerName: config.mockMode ? 'mock' : 'gmail',
    },
    // F4: import is a bulk-write surface (multipart CSV → dry-run → commit) —
    // never leave it on its injected default. Guard + a real authenticated actor.
    imports: {
      storage: new ImportStorage(env['IMPORT_STORAGE_DIR'] ?? '/var/lib/switchboard/imports'),
      getActor: (request) => (request.user ? { userId: request.user.id } : null),
      preHandler: adminGuard,
    },
    adminAudit: { adminGuard },
    adminExport: { adminGuard },
    adminCrud: { adminGuard },
    inbox: { queue },
  });

  // ── Sequence worker: enqueue due intents, drain them through real Redis ────
  // The sweeper is the safety net — BullMQ delays are an optimisation, Postgres
  // (send_intents.due_at) is the source of truth (§4.3), so a lost Redis job is
  // simply re-enqueued on the next sweep.
  const sweeper = setInterval(() => {
    void sweepDueIntents({ db, queue, now: () => new Date(), claimTimeoutMs: CLAIM_TIMEOUT_MS })
      .then((count) => {
        if (count > 0) app.log.info({ count }, 'swept due send-intents');
      })
      .catch((error: unknown) => {
        errorSink.captureException(error, { where: 'sequence-sweeper' });
      });
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  await app.ready();

  const shutdown = createGracefulShutdown({
    app,
    resources: [
      { name: 'sweeper', close: () => clearInterval(sweeper) },
      { name: 'queue', close: () => queue.close() },
      { name: 'queue-probe', close: () => probeQueue.close() },
      { name: 'postgres', close: () => pool.end() },
    ],
  });
  shutdown.install();

  return {
    app,
    db,
    queue,
    close: async () => {
      await app.close();
      await queue.close();
      await probeQueue.close();
      await pool.end();
    },
  };
}

/** Entry: boot the role this process was given. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  const role = readRole(env);
  const built = await buildProductionApp({ config, env });

  if (role === 'server') {
    const address = await built.app.listen({ port: config.port, host: '0.0.0.0' });
    built.app.log.info({ address, role, mockMode: config.mockMode }, 'switchboard api listening');
  } else {
    built.app.log.info({ role }, 'switchboard worker started');
  }
}
