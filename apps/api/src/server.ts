import Fastify, { type FastifyInstance } from 'fastify';

export interface HealthzResponse {
  ok: boolean;
  checks: Record<string, unknown>;
}

/**
 * Builds the Fastify app. Routes/services/workers are added in later phases;
 * for now the skeleton boots and answers the liveness probe.
 * `/healthz` will grow real checks (Postgres, Redis, queue depth, sync-lag) in
 * Phase 5 (ARCHITECTURE §8) — the shape `{ ok, checks }` is fixed now.
 */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', async (): Promise<HealthzResponse> => ({ ok: true, checks: {} }));

  return app;
}
