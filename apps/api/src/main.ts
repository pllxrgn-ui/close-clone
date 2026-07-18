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
import { processIntent } from './services/sequences/dispatch.ts';
import { SEND_JOB_NAME } from './services/sequences/job-names.ts';
import { handleTelephonyJob, TWILIO_PROCESS_JOB } from './services/telephony/worker.ts';
import { processPendingTwilioWebhooks } from './services/telephony/process.ts';
import { SignatureTwilioVerifier } from './services/telephony/ingress.ts';
import { MOCK_TWILIO_AUTH_TOKEN } from './providers/telephony/twilio-signature.ts';
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
import {
  TokenService,
  PostgresRateLimiter,
  createBearerAuthPreHandler,
} from './services/tokens/index.ts';
import { registerAdminTokenRoutes } from './routes/admin-tokens.ts';
import { registerWebhookSubscriptionRoutes } from './routes/webhook-subscriptions.ts';
import {
  createWebhookDeliveryProcessor,
  createActivityWebhookEmitter,
  sweepPendingWebhookDeliveries,
  type WebhookSender,
} from './services/webhooks/index.ts';
import { SessionCodec } from './auth/session/session.ts';
import { OidcTxnCodec } from './auth/session/txn.ts';
import { OidcClient } from './auth/oidc/index.ts';
import { registerOidcAuthRoutes } from './auth/routes.ts';
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
  // Real mode: the signed OIDC session cookie the login callback issued. Its
  // `read` returns exactly the SessionReader shape (userId + optional sliding-
  // renewal Set-Cookie the guard echoes). `secure` defaults on (TLS-terminated
  // upstream, ARCHITECTURE §8).
  const codec = new SessionCodec({ secret: config.sessionSecret });
  return (request) => codec.read(request.headers.cookie);
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
  // Gmail gates ONLY email/sequences-email — a missing account pauses that
  // feature, never the boot (guide §1/§4.6). The eager registry throws in real
  // mode without Gmail config, so build it only when configured; SSO, leads,
  // pipeline etc. run without a Google account. The sender registry is lazy
  // (throws per-send, not at construction), so it is always safe to build.
  const gmailConfigured = config.mockMode || (env['GOOGLE_CLIENT_ID'] ?? '') !== '';
  const gmail =
    !config.mockMode && gmailConfigured
      ? {
          clientId: env['GOOGLE_CLIENT_ID']!,
          clientSecret: env['GOOGLE_CLIENT_SECRET'] ?? '',
          address: env['GMAIL_SENDER_ADDRESS'] ?? '',
        }
      : undefined;
  const registry = gmailConfigured
    ? createProviderRegistry({ mockMode: config.mockMode, ...(gmail ? { gmail } : {}) })
    : null;
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

  // Internal API: other internal systems authenticate with a Bearer TOKEN
  // instead of a session cookie. The token pre-handler does hash lookup + scope
  // + Postgres fixed-window rate limit (no Redis), and decorates request.apiToken.
  // Scope is derived from the route so a read token cannot mutate (I-RAIL-API):
  // reports → read:reports, other GET → read:leads, anything mutating →
  // write:leads. A write scope is permission to ASK the engine, never to bypass
  // a compliance rail (those re-check inside the send/dial transaction).
  const tokenService = new TokenService(db);
  const rateLimiter = new PostgresRateLimiter(db);
  const bearerDeps = { db, tokens: tokenService, rateLimiter };
  const bearerRead = createBearerAuthPreHandler(bearerDeps, { scope: 'read:leads' });
  const bearerWrite = createBearerAuthPreHandler(bearerDeps, { scope: 'write:leads' });
  const bearerReports = createBearerAuthPreHandler(bearerDeps, { scope: 'read:reports' });

  const EXEMPT = (url: string): boolean =>
    url.startsWith('/wh/') ||
    url.startsWith('/healthz') ||
    url.startsWith('/api/v1/unsubscribe') ||
    // The login/callback routes issue the session — they cannot require one.
    url.startsWith('/api/v1/auth/login') ||
    url.startsWith('/api/v1/auth/callback') ||
    (config.mockMode && url.startsWith('/api/v1/auth/dev-'));

  const hasBearer = (request: { headers: Record<string, unknown> }): boolean => {
    const h = request.headers['authorization'];
    return typeof h === 'string' && h.startsWith('Bearer ');
  };

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/')) return;
    if (EXEMPT(request.url)) return;
    if (hasBearer(request)) {
      // The admin/* surface stays session-only (requireAdmin needs a session
      // user); a token cannot reach it — a deliberately safe limitation.
      const guard = request.url.startsWith('/api/v1/reports')
        ? bearerReports
        : request.method === 'GET' || request.method === 'HEAD'
          ? bearerRead
          : bearerWrite;
      await guard.call(app, request, reply, () => undefined);
      return;
    }
    await sessionGuard.call(app, request, reply, () => undefined);
  });

  if (config.mockMode) {
    registerDevAuthRoutes(app, { db, sessionSecret: config.sessionSecret });
  } else {
    // Real SSO: the login → IdP → callback flow that MINTS the session cookie
    // the reader above reads. assertRealModeConfig already proved these env
    // vars are present, so the non-null assertions are safe.
    const oidcClient = new OidcClient({
      issuer: env['OIDC_ISSUER']!,
      clientId: env['OIDC_CLIENT_ID']!,
      clientSecret: env['OIDC_CLIENT_SECRET']!,
    });
    const webOrigin = env['WEB_ORIGIN'] ?? env['PUBLIC_WEBHOOK_URL'] ?? '';
    registerOidcAuthRoutes(app, {
      db,
      client: oidcClient,
      session: new SessionCodec({ secret: config.sessionSecret }),
      txn: new OidcTxnCodec({ secret: config.sessionSecret }),
      redirectUri: `${webOrigin}/api/v1/auth/callback`,
      postLoginRedirect: `${webOrigin}/inbox`,
      loginErrorRedirect: `${webOrigin}/login`,
    });
  }

  // One shared activity→webhook emitter for every producer (routes + the
  // sequence dispatch worker below), so a subscriber sees activity.recorded for
  // rep CRUD AND for sequence-driven outbound.
  const activityEmitter = createActivityWebhookEmitter(queue);

  registerRoutes(app, {
    db,
    emailSend: { providerFor: senderRegistry.providerFor, cipher },
    sequences: { queue, now: () => new Date() },
    unsubscribe: { secret: env['LIST_UNSUBSCRIBE_SECRET'] ?? config.sessionSecret },
    // Email sync routes only when a provider exists (mock, or real + Gmail
    // configured). Absent → the routes are simply not mounted; the rest of the
    // API is unaffected.
    ...(registry !== null
      ? {
          email: {
            db,
            provider: registry.email,
            cipher,
            verifier: new MockGmailPushVerifier(),
            redirectUri: `${env['PUBLIC_WEBHOOK_URL'] ?? ''}/api/v1/oauth/gmail/callback`,
            providerName: config.mockMode ? 'mock' : 'gmail',
          },
        }
      : {}),
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
    // Fan domain events onto outbound webhooks: activity.recorded stages its
    // delivery rows inside the record transaction, then enqueues post-commit
    // through this queue-backed emitter (createWebhookDeliveryProcessor above
    // delivers them). Wired for the notes surface; other activity producers
    // adopt the same one-param pattern.
    activityEmitter,
    // Telephony (click-to-call, /wh/twilio ingress) + AI (summaries, drafting,
    // NL→Smart View) mount only when their providers exist — mock now; the real
    // Twilio/Deepgram/Haiku adapters + accounts are HUMAN_TODO (WIRING.md §5),
    // and the registry real branch builds only email, so in real mode these
    // stay unmounted until that lands. Twilio signs the FULL public URL, so
    // publicBaseUrl must be the external origin, never the proxy host.
    ...(registry?.telephony !== undefined
      ? {
          telephony: {
            verifier: new SignatureTwilioVerifier(
              config.mockMode ? MOCK_TWILIO_AUTH_TOKEN : (env['TWILIO_AUTH_TOKEN'] ?? ''),
            ),
            dialProvider: registry.telephony,
            now: () => new Date(),
            publicBaseUrl: env['PUBLIC_WEBHOOK_URL'] ?? `http://localhost:${config.port}`,
            queue,
            ...(env['TWILIO_PHONE_NUMBER'] !== undefined
              ? { callerId: env['TWILIO_PHONE_NUMBER'] }
              : {}),
          },
        }
      : {}),
    ...(registry?.asr !== undefined && registry.ai !== undefined
      ? { ai: { asr: registry.asr, ai: registry.ai, now: () => new Date() } }
      : {}),
  });

  // Admin CRUD for the internal API's own credentials: issue/revoke API tokens
  // and manage outbound webhook subscriptions. Admin-guarded (session-only),
  // so a token cannot mint or escalate tokens. The acting admin is the session
  // user (created_by / audit actor).
  registerAdminTokenRoutes(app, {
    db,
    adminGuard,
    resolveActorId: (request) => request.user?.id ?? null,
  });
  registerWebhookSubscriptionRoutes(app, { db, adminGuard });

  // ── Sequence worker: CONSUME the queue, then keep it fed ──────────────────
  // `processIntent` re-checks every rail (reply/bounce/suppression/window/cap)
  // INSIDE the send transaction (§4.3 never-events) — this binding is what
  // turns enqueued intents into actual sends. Without it the sweeper would
  // enqueue into Redis forever and no sequence step would ever go out.
  const unsubscribeConfig = {
    baseUrl: env['PUBLIC_WEBHOOK_URL'] ?? `http://localhost:${config.port}`,
    mailbox: env['UNSUBSCRIBE_MAILBOX'] ?? 'unsubscribe@switchboard.internal',
    secret: env['LIST_UNSUBSCRIBE_SECRET'] ?? config.sessionSecret,
  };
  const dispatchDeps = {
    db,
    providerFor: senderRegistry.providerFor,
    cipher,
    queue,
    // Distinguishes this replica in send_intents.worker_id (§4.3 claim audit).
    workerId: `${env['HOSTNAME'] ?? 'api'}:${process.pid}`,
    now: () => new Date(),
    unsubscribe: unsubscribeConfig,
    emitter: activityEmitter,
    sms: {
      // No telephony account (HUMAN_TODO: TWILIO_*) → no fromNumber either, so
      // dispatch SKIPs sms steps with `no_sms_from_number` before ever touching
      // this. It exists for the misconfigured case (a number set, credentials
      // missing): refuse loudly → the intent lands FAILED/provider_error with
      // this message, rather than a step silently disappearing.
      provider: registry?.telephony ?? {
        sendSms: (): Promise<never> => {
          throw new Error('telephony provider not configured (TWILIO_* unset): cannot send SMS');
        },
      },
      ...(env['TWILIO_PHONE_NUMBER'] !== undefined
        ? { fromNumber: env['TWILIO_PHONE_NUMBER'] }
        : {}),
    },
  };
  // Telephony ingress: an inbound Twilio webhook persists a webhook_inbox row,
  // then enqueues twilio:process; this worker turns that row into timeline
  // events (call logged, sms received, STOP opt-out). deps.provider only needs
  // sendSms (the quiet-hours opt-out confirmation). Present only when a
  // telephony provider exists (mock now; real Twilio is HUMAN_TODO).
  const telephonyProcessDeps =
    registry?.telephony !== undefined ? { db, provider: registry.telephony } : null;

  // Outbound webhook delivery (guide §5c): emitWebhookEvent (fired by domain
  // events) writes durable webhook_deliveries rows + enqueues webhook:deliver;
  // this processor POSTs each with its stored HMAC-signed envelope and owns
  // retries/backoff/dead-letter. The sender is the one network seam — the target
  // URL was validated (https + public host, SSRF guard) at subscription create;
  // delivery-time resolve-and-pin against DNS rebinding is the documented
  // remaining hardening (WIRING.md).
  const webhookSender: WebhookSender = async ({ url, headers, body }) => {
    const res = await fetch(url, { method: 'POST', headers, body });
    return { status: res.status };
  };
  const webhookDeliveryProcessor = createWebhookDeliveryProcessor({
    db,
    sender: webhookSender,
    queue,
  });

  queue.process(async (job) => {
    if (job.name === SEND_JOB_NAME) {
      const intentId = (job.data as { intentId?: string }).intentId;
      if (intentId !== undefined) await processIntent(dispatchDeps, intentId);
      return;
    }
    if (job.name === TWILIO_PROCESS_JOB && telephonyProcessDeps !== null) {
      await handleTelephonyJob(telephonyProcessDeps, job);
      return;
    }
    await webhookDeliveryProcessor(job);
  });

  // The sweeper is the safety net — BullMQ delays are an optimisation, Postgres
  // (send_intents.due_at / webhook_inbox) is the source of truth (§4.3), so a
  // lost Redis job is simply re-processed on the next sweep.
  const sweeper = setInterval(() => {
    void sweepDueIntents({ db, queue, now: () => new Date(), claimTimeoutMs: CLAIM_TIMEOUT_MS })
      .then((count) => {
        if (count > 0) app.log.info({ count }, 'swept due send-intents');
      })
      .catch((error: unknown) => {
        errorSink.captureException(error, { where: 'sequence-sweeper' });
      });
    if (telephonyProcessDeps !== null) {
      void processPendingTwilioWebhooks(telephonyProcessDeps).catch((error: unknown) => {
        errorSink.captureException(error, { where: 'telephony-sweeper' });
      });
    }
    // Outbound-webhook relay: re-enqueue any committed-but-pending delivery
    // (the outbox safety net — makes activity.recorded emission race-free even
    // if a low-latency flush lost the commit race or Redis blipped).
    void sweepPendingWebhookDeliveries(db, queue)
      .then((count) => {
        if (count > 0) app.log.info({ count }, 'swept pending webhook-deliveries');
      })
      .catch((error: unknown) => {
        errorSink.captureException(error, { where: 'webhook-delivery-sweeper' });
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
