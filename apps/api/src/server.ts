import Fastify, { type FastifyInstance } from 'fastify';

import type { Db } from './db/index.ts';
import { registerRoutes } from './routes/index.ts';

export interface HealthzResponse {
  ok: boolean;
  checks: Record<string, unknown>;
}

export interface BuildServerDeps {
  /**
   * Database handle. When present, the `/api/v1/*` routes are mounted; when
   * omitted the app boots with only the liveness probe (used by the server
   * smoke test, and by any caller that has not yet wired the DB layer).
   */
  db?: Db;
}

/**
 * Builds the Fastify app. `/healthz` is the liveness probe (its `{ ok, checks }`
 * shape is fixed; real checks land in Phase 5, ARCHITECTURE §8). Versioned REST
 * resources are mounted through `registerRoutes` (CONTRACTS §C7) when a `db` is
 * provided.
 */
export function buildServer(deps: BuildServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', async (): Promise<HealthzResponse> => ({ ok: true, checks: {} }));

  if (deps.db !== undefined) {
    registerRoutes(app, { db: deps.db });
  }

  return app;
}
