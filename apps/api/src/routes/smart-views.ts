import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import {
  ParseError,
  rawClientOf,
  SmartViewInputError,
  SmartViewService,
  type RawQueryable,
  type SmartViewPreviewInput,
} from '../services/smartviews/index.ts';
import { sendError } from './http.ts';

/**
 * Smart-view REST surface (CONTRACTS §C7 `smart-views` + `POST
 * /smart-views/preview`, Task R3). A DROP-IN for the web's MSW layer: the paths,
 * request bodies, and response shapes match `apps/web/src/api/smartViews.ts` +
 * `api/types.ts` exactly, so flipping `VITE_API_MODE=real` needs zero web changes.
 *
 *   GET    /api/v1/smart-views           — list (owner + shared + unowned)
 *   GET    /api/v1/smart-views/:id       — read (404 if absent)
 *   POST   /api/v1/smart-views           — create (dsl parsed by the compiler)
 *   PATCH  /api/v1/smart-views/:id       — partial update (re-parses changed dsl)
 *   DELETE /api/v1/smart-views/:id       — 204
 *   POST   /api/v1/smart-views/preview   — {dsl|ast} → { items, countEstimate, nextCursor? }
 *
 * Preview runs the compiler (the SINGLE query authority, C3) against the real
 * `leads` table — parameters only, no hand-written WHERE. Two composition seams,
 * matching the repo convention (see imports.ts): `getActor` resolves the session
 * user (binds `owner in (me)` + create ownership) and an optional RBAC preHandler.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface SmartViewActor {
  userId: string;
}

export interface SmartViewRouteDeps {
  db: Db;
  /**
   * Raw client for the compiler's `$n` SQL. Optional: derived from `db.$client`
   * when omitted (works for PGlite + node-postgres). Tests inject explicitly.
   */
  client?: RawQueryable;
  /** Org timezone for relative-date resolution in previews (C3). */
  orgTimezone: string;
  /** Resolve the session user; `null` ⇒ fall back to `defaultUserId` for `me`. */
  getActor?: (request: FastifyRequest) => SmartViewActor | null | Promise<SmartViewActor | null>;
  /** `me` fallback + create owner when there is no resolved actor. */
  defaultUserId: string;
  /** Optional RBAC gate(s) run before every handler (orchestrator-wired). */
  preHandler?: import('fastify').preHandlerHookHandler | import('fastify').preHandlerHookHandler[];
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  dsl: z.string().min(1),
  shared: z.boolean().optional(),
  sort: z.record(z.unknown()).nullable().optional(),
  columns: z.array(z.unknown()).nullable().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  dsl: z.string().min(1).optional(),
  shared: z.boolean().optional(),
  sort: z.record(z.unknown()).nullable().optional(),
  columns: z.array(z.unknown()).nullable().optional(),
});

const previewSchema = z.object({
  dsl: z.string().optional(),
  ast: z.unknown().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Map a service-layer error to its §C8 reply; null ⇒ not ours (rethrow → 500). */
function mapSmartViewError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof ParseError) {
    return sendError(reply, 'VALIDATION_FAILED', err.message, { position: err.position });
  }
  if (err instanceof SmartViewInputError) {
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  }
  return null;
}

export function registerSmartViewRoutes(app: FastifyInstance, deps: SmartViewRouteDeps): void {
  const client = deps.client ?? rawClientOf(deps.db);
  const service = new SmartViewService({ db: deps.db, client, orgTimezone: deps.orgTimezone });
  const routeOpts = deps.preHandler !== undefined ? { preHandler: deps.preHandler } : {};

  const currentUserId = async (request: FastifyRequest): Promise<string> => {
    const actor = deps.getActor ? await deps.getActor(request) : null;
    return actor?.userId ?? deps.defaultUserId;
  };

  // POST /smart-views/preview — first page + count estimate for {dsl|ast}.
  app.post('/api/v1/smart-views/preview', routeOpts, async (request, reply) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid preview request',
        parsed.error.flatten(),
      );
    }
    const input: SmartViewPreviewInput = {
      ...(parsed.data.dsl !== undefined ? { dsl: parsed.data.dsl } : {}),
      ...(parsed.data.ast !== undefined ? { ast: parsed.data.ast } : {}),
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    };
    try {
      const result = await service.preview(input, await currentUserId(request), new Date());
      return reply.send(result);
    } catch (err) {
      const mapped = mapSmartViewError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // GET /smart-views — list visible views (owner + shared + unowned).
  app.get('/api/v1/smart-views', routeOpts, async (request) => {
    return service.list(await currentUserId(request));
  });

  // GET /smart-views/:id
  app.get<{ Params: { id: string } }>(
    '/api/v1/smart-views/:id',
    routeOpts,
    async (request, reply) => {
      const view = await service.get(request.params.id);
      if (view === null) return sendError(reply, 'NOT_FOUND', 'Smart view not found');
      return view;
    },
  );

  // POST /smart-views — create.
  app.post('/api/v1/smart-views', routeOpts, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'name and dsl are required',
        parsed.error.flatten(),
      );
    }
    try {
      const created = await service.create(
        {
          name: parsed.data.name,
          dsl: parsed.data.dsl,
          ...(parsed.data.shared !== undefined ? { shared: parsed.data.shared } : {}),
          ...(parsed.data.sort !== undefined ? { sort: parsed.data.sort } : {}),
          ...(parsed.data.columns !== undefined ? { columns: parsed.data.columns } : {}),
        },
        await currentUserId(request),
      );
      return reply.status(201).send(created);
    } catch (err) {
      const mapped = mapSmartViewError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // PATCH /smart-views/:id — partial update.
  app.patch<{ Params: { id: string } }>(
    '/api/v1/smart-views/:id',
    routeOpts,
    async (request, reply) => {
      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_FAILED', 'invalid update', parsed.error.flatten());
      }
      try {
        const updated = await service.update(request.params.id, {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.dsl !== undefined ? { dsl: parsed.data.dsl } : {}),
          ...(parsed.data.shared !== undefined ? { shared: parsed.data.shared } : {}),
          ...(parsed.data.sort !== undefined ? { sort: parsed.data.sort } : {}),
          ...(parsed.data.columns !== undefined ? { columns: parsed.data.columns } : {}),
        });
        if (updated === null) return sendError(reply, 'NOT_FOUND', 'Smart view not found');
        return updated;
      } catch (err) {
        const mapped = mapSmartViewError(reply, err);
        if (mapped !== null) return mapped;
        throw err;
      }
    },
  );

  // DELETE /smart-views/:id → 204.
  app.delete<{ Params: { id: string } }>(
    '/api/v1/smart-views/:id',
    routeOpts,
    async (request, reply) => {
      const removed = await service.remove(request.params.id);
      if (!removed) return sendError(reply, 'NOT_FOUND', 'Smart view not found');
      return reply.status(204).send();
    },
  );
}
