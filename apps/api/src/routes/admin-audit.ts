import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { auditActorTypeSchema } from '@switchboard/shared';

import type { Db } from '../db/index.ts';
import {
  AuditQueryService,
  InvalidAuditCursorError,
  type AuditQueryFilter,
} from '../services/audit/index.ts';
import { sendError } from './http.ts';

/**
 * `GET /api/v1/admin/audit-log` (CONTRACTS §C7, `admin/*` — admin RBAC). Zod-
 * validates the filter query string, delegates filtering + keyset pagination to
 * `AuditQueryService`, and returns the `{ items, nextCursor? }` envelope. Every
 * snapshot is redacted by the service, so token material never leaves here.
 *
 * RBAC/auth does not exist yet (Task 5a). This factory takes an INJECTED admin
 * guard (`adminGuard`, a Fastify preHandler) and mounts it on the route; the
 * orchestrator wires the real guard at registration time. Until then a test/mock
 * guard is injected. See the module's registration note in the task report.
 */

const querySchema = z.object({
  actorId: z.string().uuid().optional(),
  actorType: auditActorTypeSchema.optional(),
  entity: z.string().min(1).optional(),
  entityId: z.string().uuid().optional(),
  action: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

export interface AdminAuditRouteDeps {
  db: Db;
  /** Injected admin RBAC guard (Task 5a). Runs before the handler. */
  adminGuard: preHandlerHookHandler;
}

export function registerAdminAuditRoutes(app: FastifyInstance, deps: AdminAuditRouteDeps): void {
  const service = new AuditQueryService(deps.db);

  app.get('/api/v1/admin/audit-log', { preHandler: deps.adminGuard }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid audit-log query',
        parsed.error.flatten(),
      );
    }

    const q = parsed.data;
    const filter: AuditQueryFilter = {
      ...(q.actorId !== undefined ? { actorId: q.actorId } : {}),
      ...(q.actorType !== undefined ? { actorType: q.actorType } : {}),
      ...(q.entity !== undefined ? { entity: q.entity } : {}),
      ...(q.entityId !== undefined ? { entityId: q.entityId } : {}),
      ...(q.action !== undefined ? { action: q.action } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    };

    try {
      const page = await service.list(filter);
      return reply.send(page);
    } catch (err) {
      if (err instanceof InvalidAuditCursorError) {
        return sendError(reply, 'VALIDATION_FAILED', err.message);
      }
      throw err;
    }
  });
}
