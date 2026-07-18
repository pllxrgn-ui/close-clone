import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.ts';
import type { ActivityWebhookEmitter } from '../services/activity/index.ts';
import { registerSearchRoutes } from './search.ts';
import { registerEmailSyncRoutes, type EmailRouteDeps } from './email-sync.ts';
import { registerEmailTriageRoutes } from './email-triage.ts';
import { registerTemplateRoutes } from './templates.ts';
import { registerSnippetRoutes } from './snippets.ts';
import { registerEmailThreadRoutes } from './email-threads.ts';
import { registerEmailSendRoutes, type EmailSendRouteDeps } from './email-send.ts';
import { registerSequenceRoutes, type SequenceRouteDeps } from './sequences.ts';
import { registerUnsubscribeRoutes, type UnsubscribeRouteDeps } from './unsubscribe.ts';
import { registerReportsRoutes } from './reports.ts';
import { registerTelephonyRoutes, type TelephonyRouteDeps } from './telephony.ts';
import { registerSmsRoutes, type SmsRouteDeps } from './sms.ts';
import { registerAiRoutes, type AiRouteDeps } from './ai.ts';
import { registerImportRoutes, type ImportRouteDeps } from './imports.ts';
import { registerAdminAuditRoutes, type AdminAuditRouteDeps } from './admin-audit.ts';
import { registerAdminExportRoutes, type AdminExportRouteDeps } from './admin-export.ts';
import { registerLeadRoutes } from './leads.ts';
import { registerContactRoutes } from './contacts.ts';
import { registerOpportunitiesRoutes } from './opportunities.ts';
import { registerTasksRoutes } from './tasks.ts';
import { registerNotesRoutes } from './notes.ts';
import { registerInboxRoutes, type InboxRouteDeps } from './inbox.ts';
import { registerSmartViewRoutes, type SmartViewRouteDeps } from './smart-views.ts';
import { registerBulkRoutes, type BulkRouteDeps } from './bulk.ts';
import { registerAdminCrudRoutes, type AdminCrudRouteDeps } from './admin-crud.ts';

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
  /** Sequence engine deps (enroll uses `queue` + `now`); `db` reused from above. */
  sequences?: Omit<SequenceRouteDeps, 'db'>;
  /** Public one-click unsubscribe (needs the List-Unsubscribe token secret). */
  unsubscribe?: Omit<UnsubscribeRouteDeps, 'db'>;
  /** CSV import resource (storage + identity seam; RBAC preHandler optional). */
  imports?: Omit<ImportRouteDeps, 'db'>;
  /** Admin audit-log reads (requires the admin RBAC preHandler; 5a supplies the real one). */
  adminAudit?: Omit<AdminAuditRouteDeps, 'db'>;
  /** Admin data export (admin RBAC preHandler + optional exportsRoot). */
  adminExport?: Omit<AdminExportRouteDeps, 'db'>;
  /** Telephony: Twilio ingress + calls/dial + dialer/recording (real Twilio deps
   *  — verifier/publicBaseUrl — from the deploy root; mock deps under MOCK_MODE). */
  telephony?: Omit<TelephonyRouteDeps, 'db'>;
  /** Two-way SMS send (I-QUIET/I-DNC); provider from the registry. */
  sms?: Omit<SmsRouteDeps, 'db'>;
  /** AI: call summaries + email drafting + NL→Smart View (confirm-before-commit). */
  ai?: Omit<AiRouteDeps, 'db'>;
  /** Inbox composed reads + review dispositions (db-only; optional now/queue). */
  inbox?: Omit<InboxRouteDeps, 'db'>;
  /** Smart View CRUD + preview (needs orgTimezone + defaultUserId for `me`/relative dates). */
  smartViews?: Omit<SmartViewRouteDeps, 'db'>;
  /** Bulk-action engine over a Smart View target set (needs orgTimezone + queue + defaultUserId). */
  bulk?: Omit<BulkRouteDeps, 'db'>;
  /** Admin CRUD (users/custom-fields/org-settings/suppressions) — needs the admin RBAC guard. */
  adminCrud?: Omit<AdminCrudRouteDeps, 'db'>;
  /** Fans domain events onto outbound webhooks (activity.recorded, …). Injected
   *  by the composition root; absent in tests/mock = no fan-out. */
  activityEmitter?: ActivityWebhookEmitter;
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
  if (deps.sequences !== undefined) {
    registerSequenceRoutes(app, {
      db: deps.db,
      queue: deps.sequences.queue,
      now: deps.sequences.now,
    });
  }
  if (deps.unsubscribe !== undefined) {
    registerUnsubscribeRoutes(app, { db: deps.db, secret: deps.unsubscribe.secret });
  }
  registerReportsRoutes(app, { db: deps.db });
  // Product-CRUD resources (db-only) — the real API the web binds to in real mode.
  registerLeadRoutes(app, { db: deps.db });
  registerContactRoutes(app, {
    db: deps.db,
    ...(deps.activityEmitter !== undefined ? { activityEmitter: deps.activityEmitter } : {}),
  });
  registerOpportunitiesRoutes(app, {
    db: deps.db,
    ...(deps.activityEmitter !== undefined ? { activityEmitter: deps.activityEmitter } : {}),
  });
  registerTasksRoutes(app, {
    db: deps.db,
    ...(deps.activityEmitter !== undefined ? { activityEmitter: deps.activityEmitter } : {}),
  });
  registerNotesRoutes(app, {
    db: deps.db,
    ...(deps.activityEmitter !== undefined ? { activityEmitter: deps.activityEmitter } : {}),
  });
  registerInboxRoutes(app, { db: deps.db, ...(deps.inbox ?? {}) });
  if (deps.smartViews !== undefined) {
    registerSmartViewRoutes(app, { db: deps.db, ...deps.smartViews });
  }
  if (deps.bulk !== undefined) {
    registerBulkRoutes(app, { db: deps.db, ...deps.bulk });
  }
  if (deps.adminCrud !== undefined) {
    registerAdminCrudRoutes(app, { db: deps.db, ...deps.adminCrud });
  }
  if (deps.telephony !== undefined) {
    registerTelephonyRoutes(app, { db: deps.db, ...deps.telephony });
  }
  if (deps.sms !== undefined) {
    registerSmsRoutes(app, { db: deps.db, ...deps.sms });
  }
  if (deps.ai !== undefined) {
    registerAiRoutes(app, { db: deps.db, ...deps.ai });
  }
  if (deps.imports !== undefined) {
    registerImportRoutes(app, { db: deps.db, ...deps.imports });
  }
  if (deps.adminAudit !== undefined) {
    registerAdminAuditRoutes(app, { db: deps.db, ...deps.adminAudit });
  }
  if (deps.adminExport !== undefined) {
    registerAdminExportRoutes(app, { db: deps.db, ...deps.adminExport });
  }
}

export { registerEmailSyncRoutes, type EmailRouteDeps } from './email-sync.ts';
export { registerEmailTriageRoutes, type EmailTriageRouteDeps } from './email-triage.ts';
export { registerTemplateRoutes, type TemplateRouteDeps } from './templates.ts';
export { registerSnippetRoutes, type SnippetRouteDeps } from './snippets.ts';
export { registerEmailThreadRoutes, type EmailThreadRouteDeps } from './email-threads.ts';
export { registerEmailSendRoutes, type EmailSendRouteDeps } from './email-send.ts';
export { registerSequenceRoutes, type SequenceRouteDeps } from './sequences.ts';
export { registerUnsubscribeRoutes, type UnsubscribeRouteDeps } from './unsubscribe.ts';
export { sendError, ERROR_STATUS, type ErrorCode, type ErrorEnvelope } from './http.ts';
