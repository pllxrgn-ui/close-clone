import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.ts';
import { registerSearchRoutes } from './search.ts';

/**
 * REST route registration (CONTRACTS §C7). This is the repo's first route
 * module; `registerRoutes` is the single entry point the Fastify app calls to
 * mount every `/api/v1/*` resource. New resources add a `register*Routes(app,
 * deps)` module and one line here. `/healthz` stays on the app directly (it is a
 * liveness probe, not a versioned API resource).
 */

export interface RouteDeps {
  db: Db;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerSearchRoutes(app, deps);
}

export { sendError, ERROR_STATUS, type ErrorCode, type ErrorEnvelope } from './http.ts';
