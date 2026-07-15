import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.ts';
import { registerSearchRoutes } from './search.ts';
import { registerEmailSyncRoutes, type EmailRouteDeps } from './email-sync.ts';
import { registerEmailTriageRoutes } from './email-triage.ts';
import { registerTemplateRoutes } from './templates.ts';
import { registerSnippetRoutes } from './snippets.ts';
import { registerEmailThreadRoutes } from './email-threads.ts';
import { registerEmailSendRoutes, type EmailSendRouteDeps } from './email-send.ts';

/**
 * REST route registration (CONTRACTS §C7). This is the repo's single entry point
 * the Fastify app calls to mount every `/api/v1/*` resource. New resources add a
 * `register*Routes(app, deps)` module and one line here. `/healthz` stays on the
 * app directly (it is a liveness probe, not a versioned API resource).
 *
 * DB-only resources (templates, snippets, thread reads, triage, search) mount
 * unconditionally. Resources that need injected adapters mount only when their
 * deps are supplied — the composition root wires those from the provider registry:
 *   - `deps.email`     → sync OAuth + `/wh/gmail` (provider, cipher, push verifier);
 *   - `deps.emailSend` → `POST /emails/send` (per-account provider resolver + cipher).
 */

export interface RouteDeps {
  db: Db;
  email?: EmailRouteDeps;
  /** Per-account send-from deps (providerFor + cipher); `db` is reused from above. */
  emailSend?: Omit<EmailSendRouteDeps, 'db'>;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerSearchRoutes(app, deps);
  registerEmailTriageRoutes(app, { db: deps.db });
  registerTemplateRoutes(app, { db: deps.db });
  registerSnippetRoutes(app, { db: deps.db });
  registerEmailThreadRoutes(app, { db: deps.db });
  if (deps.email !== undefined) registerEmailSyncRoutes(app, deps.email);
  if (deps.emailSend !== undefined) {
    registerEmailSendRoutes(app, {
      db: deps.db,
      providerFor: deps.emailSend.providerFor,
      cipher: deps.emailSend.cipher,
    });
  }
}

export { registerEmailSyncRoutes, type EmailRouteDeps } from './email-sync.ts';
export { registerEmailTriageRoutes, type EmailTriageRouteDeps } from './email-triage.ts';
export { registerTemplateRoutes, type TemplateRouteDeps } from './templates.ts';
export { registerSnippetRoutes, type SnippetRouteDeps } from './snippets.ts';
export { registerEmailThreadRoutes, type EmailThreadRouteDeps } from './email-threads.ts';
export { registerEmailSendRoutes, type EmailSendRouteDeps } from './email-send.ts';
export { sendError, ERROR_STATUS, type ErrorCode, type ErrorEnvelope } from './http.ts';
