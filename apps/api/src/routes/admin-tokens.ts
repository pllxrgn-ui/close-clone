import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import {
  TokenNotFoundError,
  TokenService,
  TokenValidationError,
  apiScopeSchema,
} from '../services/tokens/index.ts';
import { sendError } from './http.ts';

/**
 * Admin token management (Task 5c, CONTRACTS §C7 `admin/*` — admin RBAC). Factory
 * routes under `/api/v1/admin/tokens`:
 *
 *   POST   /api/v1/admin/tokens            — mint (returns the plaintext ONCE)
 *   GET    /api/v1/admin/tokens            — list (keyset; never returns `hash`)
 *   POST   /api/v1/admin/tokens/:id/revoke — revoke now (idempotent)
 *
 * RBAC is the INJECTED `adminGuard` preHandler (Task 5a wires the real one), same
 * pattern as `admin-audit.ts`. `resolveActorId` (also injected) yields the acting
 * admin's user id for `created_by`; until 5a supplies it, `created_by` is null.
 *
 * CONTRACT FRICTION (reported): the C1 `audit_log` action catalog
 * (`services/audit/actions.ts`) has no `admin.token_created` / `admin.token_revoked`
 * action, and that file is outside the 5c allowlist, so token LIFECYCLE events
 * cannot be audited here yet. The recommended follow-up adds those actions and a
 * one-line `writeAudit` call. (Auth *denials* are already audited by the bearer
 * preHandler via the in-catalog `auth.denied`.)
 */

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(apiScopeSchema).min(1),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  createdBy: z.string().uuid().optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

export interface AdminTokenRouteDeps {
  db: Db;
  /** Injected admin RBAC guard (Task 5a). Runs before every handler. */
  adminGuard: preHandlerHookHandler;
  /** Resolves the acting admin's user id for `created_by`/audit; default null. */
  resolveActorId?: (request: FastifyRequest) => string | null;
  /** Injectable clock (token validity + list status). */
  now?: () => Date;
}

function mapError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof TokenNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof TokenValidationError)
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  return null;
}

export function registerAdminTokenRoutes(app: FastifyInstance, deps: AdminTokenRouteDeps): void {
  const service = new TokenService(deps.db, deps.now ?? (() => new Date()));
  const actorFor = deps.resolveActorId ?? ((): string | null => null);

  app.post('/api/v1/admin/tokens', { preHandler: deps.adminGuard }, async (request, reply) => {
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid token request', body.error.flatten());
    }
    const createdBy = actorFor(request);
    try {
      const created = await service.create({
        name: body.data.name,
        scopes: body.data.scopes,
        ...(createdBy !== null ? { createdBy } : {}),
        ...(body.data.expiresAt !== undefined ? { expiresAt: body.data.expiresAt } : {}),
      });
      // 201 with the plaintext — the ONLY time it is ever returned.
      return reply.status(201).send(created);
    } catch (err) {
      const mapped = mapError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.get('/api/v1/admin/tokens', { preHandler: deps.adminGuard }, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid query', query.error.flatten());
    }
    try {
      const page = await service.list({
        ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
        ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
        ...(query.data.createdBy !== undefined ? { createdBy: query.data.createdBy } : {}),
      });
      return reply.send(page);
    } catch (err) {
      const mapped = mapError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.post(
    '/api/v1/admin/tokens/:id/revoke',
    { preHandler: deps.adminGuard },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
      }
      try {
        const token = await service.revoke(params.data.id);
        return reply.send({ token });
      } catch (err) {
        const mapped = mapError(reply, err);
        if (mapped !== null) return mapped;
        throw err;
      }
    },
  );
}
