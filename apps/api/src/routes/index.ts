import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.ts';
import { registerSearchRoutes } from './search.ts';
import { registerEmailSyncRoutes, type EmailRouteDeps } from './email-sync.ts';
import { registerEmailTriageRoutes } from './email-triage.ts';

/**
 * REST route registration (CONTRACTS §C7). This is the repo's single entry point
 * the Fastify app calls to mount every `/api/v1/*` resource. New resources add a
 * `register*Routes(app, deps)` module and one line here. `/healthz` stays on the
 * app directly (it is a liveness probe, not a versioned API resource).
 *
 * The email sync routes (OAuth + `/wh/gmail`) require injected adapters (provider,
 * token cipher, push verifier), so they mount only when `deps.email` is supplied —
 * the composition root wires those from the provider registry.
 */

export interface RouteDeps {
  db: Db;
  email?: EmailRouteDeps;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerSearchRoutes(app, deps);
  registerEmailTriageRoutes(app, { db: deps.db });
  if (deps.email !== undefined) registerEmailSyncRoutes(app, deps.email);
}

export { registerEmailSyncRoutes, type EmailRouteDeps } from './email-sync.ts';
export { registerEmailTriageRoutes, type EmailTriageRouteDeps } from './email-triage.ts';
export { sendError, ERROR_STATUS, type ErrorCode, type ErrorEnvelope } from './http.ts';
