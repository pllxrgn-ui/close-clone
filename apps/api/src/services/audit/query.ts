import { and, desc, eq, gte, lt, or, type SQL } from 'drizzle-orm';
import type { AuditLog } from '@switchboard/shared';

import { auditLog, type Db } from '../../db/index.ts';
import type { AuditActorType } from './actions.ts';
import { redactSnapshot } from './redaction.ts';

/**
 * AuditQueryService (Task 5b) — the read side of the audit trail behind
 * `GET /api/v1/admin/audit-log` (CONTRACTS §C7). Filterable by actor, entity, and
 * action, bounded by a time range, and keyset-paginated newest-first. Every row's
 * before/after snapshot is redacted on the way out (see `./redaction.ts`) so no
 * OAuth token material can leak through the endpoint — even for rows written by a
 * path that skipped write-time redaction or inserted out of band.
 *
 * Ordering is `(at DESC, id DESC)` — a total order since ids are unique uuids — so
 * the keyset cursor is stable. Import-safe for direct `node` execution.
 */

// --- Public types -----------------------------------------------------------

export type AuditLogItem = AuditLog;

export interface AuditQueryFilter {
  actorId?: string;
  actorType?: AuditActorType;
  entity?: string;
  entityId?: string;
  /** Free string — a historical action need not still be in the write catalog. */
  action?: string;
  /** Inclusive lower bound on `at` (ISO-8601). */
  from?: string;
  /** Exclusive upper bound on `at` (ISO-8601). */
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditPage {
  items: AuditLogItem[];
  nextCursor?: string;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/** Thrown when a supplied pagination cursor is malformed. Maps to 400 (§C8). */
export class InvalidAuditCursorError extends Error {
  constructor(message = 'invalid audit-log cursor') {
    super(message);
    this.name = 'InvalidAuditCursorError';
  }
}

// --- Cursor codec (opaque base64url JSON of {at, id}) -----------------------

interface Cursor {
  at: string;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidAuditCursorError();
  }
  if (typeof parsed !== 'object' || parsed === null) throw new InvalidAuditCursorError();
  const { at, id } = parsed as Record<string, unknown>;
  if (typeof at !== 'string' || typeof id !== 'string') throw new InvalidAuditCursorError();
  if (!UUID_RE.test(id) || Number.isNaN(Date.parse(at))) throw new InvalidAuditCursorError();
  return { at, id };
}

// --- Helpers ----------------------------------------------------------------

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

type AuditLogRow = typeof auditLog.$inferSelect;

function toItem(row: AuditLogRow): AuditLogItem {
  return {
    id: row.id,
    actorId: row.actorId,
    actorType: row.actorType as AuditActorType,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    before: row.before != null ? redactSnapshot(row.before) : null,
    after: row.after != null ? redactSnapshot(row.after) : null,
    reason: row.reason,
    ip: row.ip,
    at: row.at,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// --- Service ----------------------------------------------------------------

export class AuditQueryService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async list(filter: AuditQueryFilter = {}): Promise<AuditPage> {
    const limit = clampLimit(filter.limit);
    const cursor = filter.cursor !== undefined ? decodeCursor(filter.cursor) : null;

    const conds: SQL[] = [];
    if (filter.actorId !== undefined) conds.push(eq(auditLog.actorId, filter.actorId));
    if (filter.actorType !== undefined) conds.push(eq(auditLog.actorType, filter.actorType));
    if (filter.entity !== undefined) conds.push(eq(auditLog.entity, filter.entity));
    if (filter.entityId !== undefined) conds.push(eq(auditLog.entityId, filter.entityId));
    if (filter.action !== undefined) conds.push(eq(auditLog.action, filter.action));
    if (filter.from !== undefined) conds.push(gte(auditLog.at, filter.from));
    if (filter.to !== undefined) conds.push(lt(auditLog.at, filter.to));
    if (cursor) {
      const keyset = or(
        lt(auditLog.at, cursor.at),
        and(eq(auditLog.at, cursor.at), lt(auditLog.id, cursor.id)),
      );
      if (keyset) conds.push(keyset);
    }

    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(toItem);

    if (!hasMore) return { items };
    const last = pageRows[pageRows.length - 1];
    if (last === undefined) return { items };
    return { items, nextCursor: encodeCursor({ at: last.at, id: last.id }) };
  }
}
