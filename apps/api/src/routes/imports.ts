import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z, ZodError } from 'zod';

import type { Db, ImportRow } from '../db/index.ts';
import type { ActivityWebhookEmitter } from '../services/activity/index.ts';
import {
  AlreadyCommittedError,
  commitImport,
  CommitInProgressError,
  createImport,
  dryRunImport,
  FileTooLargeError,
  ImportNotCommittableError,
  ImportNotDryRunnableError,
  ImportNotFoundError,
  ImportPlanMissingError,
  ImportStorage,
  MappingValidationError,
  MultipartError,
  parseBoundary,
  parseDryRunBody,
  readFirstFilePart,
} from '../services/imports/index.ts';
import { sendError, type ErrorCode } from './http.ts';

/**
 * CSV import REST resource (CONTRACTS §C7): the multipart upload → dry-run →
 * commit flow. Registered as an ENCAPSULATED Fastify plugin so the streaming
 * `multipart/form-data` content-type parser (no `@fastify/multipart` dependency —
 * the hand-rolled `readFirstFilePart` streams the file straight to storage) is
 * scoped to these routes and never pollutes the shared instance's parsers.
 *
 * Two seams are LEFT FOR THE ORCHESTRATOR to wire (build guide §5.2 / this task):
 *   - `getActor(request)` resolves the authenticated user (session cookie or
 *     bearer token). null ⇒ 401. No auth middleware exists in this repo yet; the
 *     Phase-2 chain owns `server.ts`/`routes/index.ts`, so identity is injected.
 *   - `preHandler` is the RBAC gate (admin / import scope). It runs before every
 *     handler; denial is a normal C8 `FORBIDDEN` reply. Compliance rails are NOT
 *     re-implemented here — suppressed contacts are imported + flagged by the
 *     planner and left to the existing send-safety rails (never contacted).
 *
 * Errors map mechanically to the §C8 taxonomy (see `importErrorToC8`).
 *
 * Import-safe for direct `node` execution (no enums / namespaces).
 */

export interface ImportActor {
  userId: string;
}

export interface ImportRouteDeps {
  db: Db;
  storage: ImportStorage;
  /** Resolve the authenticated actor; null ⇒ 401. Orchestrator wires real auth. */
  getActor: (request: FastifyRequest) => ImportActor | null | Promise<ImportActor | null>;
  /** RBAC gate(s) run before every handler (admin / import scope). Orchestrator-wired. */
  preHandler?: preHandlerHookHandler | preHandlerHookHandler[];
  /** Upload byte cap; enforced while streaming to storage. */
  maxBytes?: number;
  /** Fans import_created / lead_created onto activity.recorded webhooks. */
  activityEmitter?: ActivityWebhookEmitter;
}

const paramsSchema = z.object({ id: z.string().min(1) });

/** Public projection of an import row (internal `fileRef` / jsonb blobs omitted). */
function serializeImport(row: ImportRow): {
  id: string;
  filename: string;
  status: string;
  rowCount: number | null;
  createdBy: string;
  createdAt: ImportRow['createdAt'];
  updatedAt: ImportRow['updatedAt'];
} {
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    rowCount: row.rowCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface MappedError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/** Map an engine-layer import error to its §C8 code (null ⇒ unknown, rethrow → 500). */
function importErrorToC8(err: unknown): MappedError | null {
  if (err instanceof ImportNotFoundError) return { code: 'NOT_FOUND', message: err.message };
  if (err instanceof MappingValidationError) {
    return { code: 'VALIDATION_FAILED', message: err.message, details: err.details };
  }
  // Lifecycle / idempotency conflicts (§C8 CONFLICT): re-commit, concurrent
  // commit, wrong-state commit, dry-run of a committing import, commit with no plan.
  if (
    err instanceof AlreadyCommittedError ||
    err instanceof CommitInProgressError ||
    err instanceof ImportNotCommittableError ||
    err instanceof ImportPlanMissingError ||
    err instanceof ImportNotDryRunnableError
  ) {
    return { code: 'CONFLICT', message: err.message };
  }
  if (err instanceof FileTooLargeError) return { code: 'VALIDATION_FAILED', message: err.message };
  if (err instanceof MultipartError) return { code: 'VALIDATION_FAILED', message: err.message };
  return null;
}

function sendMapped(reply: FastifyReply, mapped: MappedError): FastifyReply {
  return sendError(reply, mapped.code, mapped.message, mapped.details);
}

/**
 * Mount the `/api/v1/imports` routes on `app`. Matches the repo's
 * `register*Routes(app, deps)` convention; internally registers an encapsulated
 * child plugin so the multipart parser is scoped.
 */
export function registerImportRoutes(app: FastifyInstance, deps: ImportRouteDeps): void {
  app.register(async (instance) => {
    // Streaming passthrough: do not buffer the body — the handler drains the raw
    // request into `readFirstFilePart`. Scoped to this encapsulated context only.
    instance.addContentTypeParser('multipart/form-data', (_request, payload, done) => {
      done(null, payload);
    });

    const routeOpts = deps.preHandler !== undefined ? { preHandler: deps.preHandler } : {};

    /** Resolve the actor or send 401; returns null when the reply was already sent. */
    const resolveActor = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<ImportActor | null> => {
      const actor = await deps.getActor(request);
      if (actor === null) {
        sendError(reply, 'UNAUTHENTICATED', 'authentication required');
        return null;
      }
      return actor;
    };

    // --- POST /imports — multipart CSV upload -------------------------------
    instance.post('/api/v1/imports', routeOpts, async (request, reply) => {
      const actor = await resolveActor(request, reply);
      if (actor === null) return reply;

      const boundary = parseBoundary(request.headers['content-type']);
      if (boundary === null) {
        return sendError(
          reply,
          'VALIDATION_FAILED',
          'expected multipart/form-data with a boundary',
        );
      }

      // The raw request stream is an AsyncIterable<Buffer>; never buffered whole.
      const source: AsyncIterable<Buffer> = request.raw;
      let filename: string;
      let body: AsyncGenerator<Buffer>;
      try {
        const file = await readFirstFilePart(source, boundary);
        filename =
          file.filename !== null && file.filename.length > 0 ? file.filename : 'import.csv';
        body = file.body;
      } catch (err) {
        const mapped = importErrorToC8(err);
        if (mapped !== null) return sendMapped(reply, mapped);
        throw err;
      }

      try {
        const row = await createImport(deps.db, deps.storage, {
          createdBy: actor.userId,
          filename,
          source: body,
          ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
        });
        return reply.status(201).send(serializeImport(row));
      } catch (err) {
        const mapped = importErrorToC8(err);
        if (mapped !== null) return sendMapped(reply, mapped);
        throw err;
      }
    });

    // --- POST /imports/:id/dry-run — plan against the DB, no writes ---------
    instance.post('/api/v1/imports/:id/dry-run', routeOpts, async (request, reply) => {
      const actor = await resolveActor(request, reply);
      if (actor === null) return reply;

      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid import id');

      let input;
      try {
        input = parseDryRunBody(request.body);
      } catch (err) {
        if (err instanceof ZodError) {
          return sendError(
            reply,
            'VALIDATION_FAILED',
            'invalid mapping or dedupe config',
            err.flatten(),
          );
        }
        throw err;
      }

      try {
        const plan = await dryRunImport(deps.db, deps.storage, params.data.id, input);
        return reply.send({ importId: params.data.id, ...plan });
      } catch (err) {
        const mapped = importErrorToC8(err);
        if (mapped !== null) return sendMapped(reply, mapped);
        throw err;
      }
    });

    // --- POST /imports/:id/commit — transactional, idempotent, resumable ----
    instance.post('/api/v1/imports/:id/commit', routeOpts, async (request, reply) => {
      const actor = await resolveActor(request, reply);
      if (actor === null) return reply;

      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid import id');

      try {
        const outcome = await commitImport(
          deps.db,
          params.data.id,
          deps.activityEmitter !== undefined ? { emitter: deps.activityEmitter } : {},
        );
        return reply.send({
          importId: params.data.id,
          status: outcome.status,
          resumed: outcome.resumed,
          counters: outcome.counters,
          nextRowIndex: outcome.nextRowIndex,
        });
      } catch (err) {
        const mapped = importErrorToC8(err);
        if (mapped !== null) return sendMapped(reply, mapped);
        throw err;
      }
    });
  });
}
