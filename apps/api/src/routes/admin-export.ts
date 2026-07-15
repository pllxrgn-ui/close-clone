import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import { AuditWriter, requestActor, type ActorHint } from '../services/audit/index.ts';
import { runExport } from '../services/export/index.ts';
import { sendError } from './http.ts';

/**
 * `POST /api/v1/admin/exports` (CONTRACTS §C7, `admin/*` — admin RBAC). Runs a
 * full-org data export (build guide §5g) to a server-side `file_ref` directory
 * and returns its manifest. The export streams every C1 entity to one file per
 * entity (JSON-lines and/or CSV); secrets are excluded and the run is bracketed
 * by `export.started` / `export.completed` audit events by the export engine.
 *
 * RBAC/auth does not exist yet (Task 5a): this factory takes an INJECTED admin
 * guard (`adminGuard`, a Fastify preHandler) and mounts it on the route. The
 * actor is read from `request.actor` when the auth layer sets it (an `ActorHint`);
 * until then it resolves to a `system` actor. Registration is wired by the
 * orchestrator (see the task report's routeWiring).
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

const bodySchema = z.object({
  format: z.enum(['jsonl', 'csv', 'both']).optional(),
  batchSize: z.number().int().min(1).max(100_000).optional(),
});

/** The auth layer (Task 5a) will attach an actor; until then this is absent. */
interface RequestWithActor extends FastifyRequest {
  actor?: ActorHint;
}

export interface AdminExportRouteDeps {
  db: Db;
  /** Injected admin RBAC guard (Task 5a). Runs before the handler. */
  adminGuard: preHandlerHookHandler;
  /** Root directory exports are written under; each export gets its own subdir. */
  exportsRoot?: string;
  /** Override the audit writer (defaults to one bound to `db`). */
  auditWriter?: AuditWriter;
}

export function registerAdminExportRoutes(app: FastifyInstance, deps: AdminExportRouteDeps): void {
  const auditWriter = deps.auditWriter ?? new AuditWriter(deps.db);
  const exportsRoot = deps.exportsRoot ?? join(tmpdir(), 'switchboard', 'exports');

  app.post('/api/v1/admin/exports', { preHandler: deps.adminGuard }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid export request', parsed.error.flatten());
    }

    const actorHint = (request as RequestWithActor).actor;
    const actor = requestActor(request, actorHint ?? null);

    const exportId = randomUUID();
    const fileRef = join(exportsRoot, exportId);

    try {
      const manifest = await runExport(deps.db, {
        outDir: fileRef,
        exportId,
        format: parsed.data.format ?? 'both',
        ...(parsed.data.batchSize !== undefined ? { batchSize: parsed.data.batchSize } : {}),
        audit: {
          writer: auditWriter,
          actorId: actor.actorId,
          actorType: actor.actorType,
          ip: actor.ip,
        },
      });

      return reply.status(201).send({
        exportId: manifest.exportId,
        fileRef,
        format: manifest.format,
        totalRows: manifest.totalRows,
        entities: manifest.entities.map((e) => ({ name: e.name, rows: e.rows })),
      });
    } catch (err) {
      request.log.error({ err }, 'data export failed');
      return sendError(reply, 'INTERNAL', 'data export failed');
    }
  });
}
