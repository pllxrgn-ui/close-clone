import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import { requestActor, type ActorHint } from '../services/audit/index.ts';
import {
  AdminConflictError,
  AdminForbiddenError,
  AdminNotFoundError,
  AdminValidationError,
  addSuppression,
  createCustomField,
  deleteCustomField,
  getOrgSettings,
  listCustomFields,
  listSuppressions,
  listUsers,
  patchOrgSettings,
  releaseSuppressionById,
  setUserActive,
  updateCustomField,
  type AdminActor,
} from '../services/admin/index.ts';
import { sendError } from './http.ts';

/**
 * Admin CRUD routes (CONTRACTS §C7 `admin/*` — admin RBAC) for the resources the
 * MVP served only from the web MSW + PGlite dev shims: users, custom-fields,
 * org-settings, suppressions. The shapes match what the web already calls so
 * flipping `VITE_API_MODE=real` is a drop-in (custom-fields GET returns the bare
 * `CustomFieldRow[]` the feature + view-builder bind; org-settings GET/PATCH the
 * `OrgSettings` singleton). `admin-audit.ts` / `admin-export.ts` / `admin-tokens.ts`
 * own the other `admin/*` routes and are untouched.
 *
 * RBAC is the INJECTED `adminGuard` preHandler (Task 5a wires the real one), same
 * pattern as the sibling admin routes; `resolveActorId` (injected) yields the
 * acting admin for audit `actor_id`. Every write is audited by the service layer
 * through the 5b writer; compliance-touching writes (recording flip, suppression
 * release/add) reuse the sanctioned engine services (never a raw column write).
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

const listSuppressionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  kind: z.enum(['email', 'phone']).optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export interface AdminCrudRouteDeps {
  db: Db;
  /** Injected admin RBAC guard (Task 5a). Runs before every handler. */
  adminGuard: preHandlerHookHandler;
  /** Resolves the acting admin's user id for audit `actor_id`; default null. */
  resolveActorId?: (request: FastifyRequest) => string | null;
}

/** Map an admin-service typed error to its C8 envelope; null → rethrow (→ 500). */
function mapAdminError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof AdminValidationError)
    return sendError(reply, 'VALIDATION_FAILED', err.message, err.details);
  if (err instanceof AdminConflictError)
    return sendError(reply, 'CONFLICT', err.message, err.details);
  if (err instanceof AdminNotFoundError)
    return sendError(reply, 'NOT_FOUND', err.message, err.details);
  if (err instanceof AdminForbiddenError)
    return sendError(reply, 'FORBIDDEN', err.message, err.details);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerAdminCrudRoutes(app: FastifyInstance, deps: AdminCrudRouteDeps): void {
  const { db } = deps;
  const guard = { preHandler: deps.adminGuard };
  const actorHintFor = deps.resolveActorId ?? ((): string | null => null);
  const actorFor = (request: FastifyRequest): AdminActor => {
    const hint: ActorHint = { id: actorHintFor(request) };
    const resolved = requestActor(request, hint);
    return { id: resolved.actorId, type: resolved.actorType, ip: resolved.ip };
  };

  // ── Users ───────────────────────────────────────────────────────────────
  app.get('/api/v1/admin/users', guard, async () => {
    return listUsers(db);
  });

  app.patch('/api/v1/admin/users/:id', guard, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    if (!isRecord(request.body)) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid body');
    }
    try {
      const user = await setUserActive(db, params.data.id, request.body, actorFor(request));
      return reply.send(user);
    } catch (err) {
      const mapped = mapAdminError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // ── Custom fields ─────────────────────────────────────────────────────────
  app.get('/api/v1/admin/custom-fields', guard, async () => {
    return listCustomFields(db);
  });

  app.post('/api/v1/admin/custom-fields', guard, async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid body');
    }
    try {
      const field = await createCustomField(
        db,
        {
          entity: request.body['entity'],
          key: request.body['key'],
          label: request.body['label'],
          type: request.body['type'],
          options: request.body['options'],
          required: request.body['required'],
        },
        actorFor(request),
      );
      return reply.status(201).send(field);
    } catch (err) {
      const mapped = mapAdminError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.patch('/api/v1/admin/custom-fields/:id', guard, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    if (!isRecord(request.body)) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid body');
    }
    try {
      const field = await updateCustomField(
        db,
        params.data.id,
        {
          label: request.body['label'],
          required: request.body['required'],
          options: request.body['options'],
        },
        actorFor(request),
      );
      return reply.send(field);
    } catch (err) {
      const mapped = mapAdminError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.delete('/api/v1/admin/custom-fields/:id', guard, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    try {
      await deleteCustomField(db, params.data.id, actorFor(request));
      return reply.status(204).send();
    } catch (err) {
      const mapped = mapAdminError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // ── Org settings ──────────────────────────────────────────────────────────
  app.get('/api/v1/admin/org-settings', guard, async (_request, reply) => {
    try {
      const settings = await getOrgSettings(db);
      return reply.send(settings);
    } catch (err) {
      const mapped = mapAdminError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.patch('/api/v1/admin/org-settings', guard, async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid body');
    }
    try {
      const settings = await patchOrgSettings(
        db,
        {
          dailySendCap: request.body['dailySendCap'],
          quietHours: request.body['quietHours'],
          sendingWindow: request.body['sendingWindow'],
          recordingEnabled: request.body['recordingEnabled'],
          legalSignoffRef: request.body['legalSignoffRef'],
          reason: request.body['reason'],
        },
        actorFor(request),
      );
      return reply.send(settings);
    } catch (err) {
      const mapped = mapAdminError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // ── Suppressions ──────────────────────────────────────────────────────────
  app.get('/api/v1/admin/suppressions', guard, async (request, reply) => {
    const query = listSuppressionsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid query', query.error.flatten());
    }
    try {
      const page = await listSuppressions(db, {
        ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
        ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
        ...(query.data.kind !== undefined ? { kind: query.data.kind } : {}),
        ...(query.data.active !== undefined ? { active: query.data.active } : {}),
      });
      return reply.send(page);
    } catch (err) {
      const mapped = mapAdminError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.post('/api/v1/admin/suppressions', guard, async (request, reply) => {
    if (!isRecord(request.body)) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid body');
    }
    try {
      const suppression = await addSuppression(
        db,
        {
          kind: request.body['kind'],
          value: request.body['value'],
          reason: request.body['reason'],
        },
        actorFor(request),
      );
      return reply.status(201).send(suppression);
    } catch (err) {
      const mapped = mapAdminError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.post('/api/v1/admin/suppressions/:id/release', guard, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid id', params.error.flatten());
    }
    const body = isRecord(request.body) ? request.body : {};
    try {
      const suppression = await releaseSuppressionById(
        db,
        params.data.id,
        { reason: body['reason'] },
        actorFor(request),
      );
      return reply.send(suppression);
    } catch (err) {
      const mapped = mapAdminError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
