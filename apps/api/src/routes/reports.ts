import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../db/index.ts';
import {
  InvalidCursorError,
  ReportRangeError,
  activityQuerySchema,
  funnelQuerySchema,
  runActivityReport,
  runFunnelReport,
  runSequencesReport,
  sequencesQuerySchema,
} from '../services/reports/index.ts';
import { sendError } from './http.ts';

/**
 * Reporting routes (Task 4g, CONTRACTS §C7 `reports/*` — read-only). A Fastify
 * plugin factory following the repo's `register*Routes(app, deps)` convention:
 *
 *   GET /api/v1/reports/activity   — per-rep / per-day activity + talk time
 *   GET /api/v1/reports/funnel     — currency-aware pipeline by stage
 *   GET /api/v1/reports/sequences  — per-sequence performance
 *
 * Every endpoint is GET-only (this module never writes — no compliance rail is
 * in play). Each zod-validates its query string and returns the keyset envelope
 * `{ items, nextCursor? }`. Bad input — a malformed query, an out-of-bounds date
 * range (`ReportRangeError`), or a malformed cursor (`InvalidCursorError`) — maps
 * to `VALIDATION_FAILED` (§C8), never a 500.
 *
 * Registration (this plugin is intentionally not wired into `routes/index.ts`,
 * which is outside this task's allowlist): add `registerReportsRoutes(app, deps)`
 * alongside `registerSearchRoutes(app, deps)` in `registerRoutes`.
 */

export interface ReportsRouteDeps {
  db: Db;
}

/** Map the report services' typed client-errors to a 400; rethrow the rest. */
function handleReportError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ReportRangeError || err instanceof InvalidCursorError) {
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  }
  throw err;
}

export function registerReportsRoutes(app: FastifyInstance, deps: ReportsRouteDeps): void {
  const { db } = deps;

  app.get('/api/v1/reports/activity', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = activityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid activity report query',
        parsed.error.flatten(),
      );
    }
    try {
      return reply.send(await runActivityReport(db, parsed.data));
    } catch (err) {
      return handleReportError(reply, err);
    }
  });

  app.get('/api/v1/reports/funnel', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = funnelQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid funnel report query',
        parsed.error.flatten(),
      );
    }
    try {
      return reply.send(await runFunnelReport(db, parsed.data));
    } catch (err) {
      return handleReportError(reply, err);
    }
  });

  app.get('/api/v1/reports/sequences', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = sequencesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid sequences report query',
        parsed.error.flatten(),
      );
    }
    try {
      return reply.send(await runSequencesReport(db, parsed.data));
    } catch (err) {
      return handleReportError(reply, err);
    }
  });
}
