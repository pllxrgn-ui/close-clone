import { and, eq, isNull, sql } from 'drizzle-orm';

import { auditLog, suppressions, type Db } from '../../db/index.ts';
import {
  auditWriteInputSchema,
  type AuditAction,
  type AuditActorType,
  type AuditSnapshot,
} from './actions.ts';
import { redactSnapshot } from './redaction.ts';

/**
 * AuditWriter (Task 5b) — the single append-only writer every module calls to
 * record to `audit_log` (CONTRACTS §C1). There is deliberately no update/delete
 * surface here; the DB trigger from migration 0011 is the backstop.
 *
 * The core is a free function `writeAudit(exec, input)` whose `exec` is any
 * Drizzle handle — the root db OR a transaction. Passing a caller's `tx` writes
 * the audit row INSIDE that transaction, so the record and its audit entry commit
 * or roll back together. This is load-bearing for the compliance-switch rule
 * (build guide §5b): flipping `org_settings.recording_enabled` and its audit row
 * must be atomic, or the ledger could disagree with reality.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

// --- Row types (inferred; schema.ts does not export these) -----------------

export type AuditLogRow = typeof auditLog.$inferSelect;
type SuppressionRow = typeof suppressions.$inferSelect;

// --- Errors ----------------------------------------------------------------

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}

/** The audit insert returned no row (should never happen; guards a `[row]` peel). */
export class AuditWriteError extends AuditError {
  constructor(message: string) {
    super(message);
    this.name = 'AuditWriteError';
  }
}

/** A reason-requiring path (suppression release) was called without one. */
export class MissingReasonError extends AuditError {
  constructor(message = 'a reason is required') {
    super(message);
    this.name = 'MissingReasonError';
  }
}

/** Suppression id not found. Maps to NOT_FOUND (§C8). */
export class SuppressionNotFoundError extends AuditError {
  readonly suppressionId: string;
  constructor(suppressionId: string) {
    super(`suppression ${suppressionId} not found`);
    this.name = 'SuppressionNotFoundError';
    this.suppressionId = suppressionId;
  }
}

/** Suppression already released. Maps to CONFLICT (§C8). */
export class SuppressionAlreadyReleasedError extends AuditError {
  readonly suppressionId: string;
  constructor(suppressionId: string) {
    super(`suppression ${suppressionId} is already released`);
    this.name = 'SuppressionAlreadyReleasedError';
    this.suppressionId = suppressionId;
  }
}

// --- Write input ------------------------------------------------------------

export interface AuditWriteInput {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  before?: AuditSnapshot | null;
  after?: AuditSnapshot | null;
  reason?: string | null;
  ip?: string | null;
  /** Override the event time; defaults to the DB `now()`. Provider/ingest time. */
  at?: string | Date;
}

function toIso(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

/**
 * Append one audit row through `exec` (a db handle or a transaction). Validates
 * the input against the C1 shape, redacts credential-bearing snapshot keys before
 * persist, and returns the inserted row. Bad input throws `ZodError`; nothing is
 * written.
 */
export async function writeAudit(exec: Db, input: AuditWriteInput): Promise<AuditLogRow> {
  // Validate BEFORE touching the DB — the ledger must not carry malformed rows.
  auditWriteInputSchema.parse(input);

  const before = input.before != null ? redactSnapshot(input.before) : null;
  const after = input.after != null ? redactSnapshot(input.after) : null;
  const at = input.at != null ? toIso(input.at) : undefined;

  const [row] = await exec
    .insert(auditLog)
    .values({
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      before,
      after,
      reason: input.reason ?? null,
      ip: input.ip ?? null,
      ...(at !== undefined ? { at } : {}),
    })
    .returning();
  if (!row) throw new AuditWriteError('audit_log insert returned no row');
  return row;
}

/** Ergonomic wrapper binding {@link writeAudit} to a db handle. */
export class AuditWriter {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Append an audit row. Pass `exec` (a transaction) to write inside a caller's
   * transaction; omit it to write against the bound db handle.
   */
  write(input: AuditWriteInput, exec?: Db): Promise<AuditLogRow> {
    return writeAudit(exec ?? this.db, input);
  }
}

// --- Request-context actor helper ------------------------------------------

/** The pieces of a request the audit layer needs (Fastify's request satisfies it). */
export interface AuditRequestLike {
  ip?: string | null | undefined;
}

export interface ActorHint {
  id?: string | null;
  type?: AuditActorType;
}

export interface ResolvedActor {
  actorId: string | null;
  actorType: AuditActorType;
  ip: string | null;
}

/**
 * Resolve the actor + ip for an audit write from request context. `actor` comes
 * from the (injected) auth/RBAC layer (Task 5a); `req.ip` from Fastify. When no
 * actor type is given it is inferred: a present actor id → `user`, otherwise
 * `system` (background jobs, sweepers). API-token callers pass `type: 'api_token'`.
 */
export function requestActor(req: AuditRequestLike, actor?: ActorHint | null): ResolvedActor {
  const actorId = actor?.id ?? null;
  const actorType: AuditActorType = actor?.type ?? (actorId !== null ? 'user' : 'system');
  return { actorId, actorType, ip: req.ip ?? null };
}

// --- Suppression release: the one blessed path (CONTRACTS §4.5) ------------

export interface ReleaseSuppressionInput {
  suppressionId: string;
  /** REQUIRED, non-empty. A release with no stated reason is rejected. */
  reason: string;
  actorId?: string | null;
  /** Defaults to `user` (release is an admin action; API tokens pass their type). */
  actorType?: AuditActorType;
  ip?: string | null;
}

export interface ReleaseSuppressionResult {
  suppression: SuppressionRow;
  audit: AuditLogRow;
}

function suppressionSnapshot(row: SuppressionRow): AuditSnapshot {
  return { ...row };
}

/**
 * Release a suppression — the single sanctioned way to set
 * `suppressions.released_*` (CONTRACTS §C1/§4.5). It REQUIRES a reason and writes
 * the `admin.suppression_released` audit row IN THE SAME TRANSACTION as the
 * update, so a released suppression can never exist without its audit trail (and
 * vice-versa). Nothing else may clear `released_at`.
 *
 * `db` may itself be a transaction; the inner `transaction()` then opens a
 * savepoint, so this composes inside a larger unit of work.
 */
export async function releaseSuppression(
  db: Db,
  input: ReleaseSuppressionInput,
): Promise<ReleaseSuppressionResult> {
  const reason = input.reason?.trim();
  if (reason === undefined || reason.length === 0) {
    throw new MissingReasonError('suppression release requires a non-empty reason');
  }

  return db.transaction(async (tx) => {
    // Lock the row for the txn so a concurrent release can't double-fire.
    const [current] = await tx
      .select()
      .from(suppressions)
      .where(eq(suppressions.id, input.suppressionId))
      .for('update');
    if (!current) throw new SuppressionNotFoundError(input.suppressionId);
    if (current.releasedAt !== null) {
      throw new SuppressionAlreadyReleasedError(input.suppressionId);
    }

    const [after] = await tx
      .update(suppressions)
      .set({
        releasedAt: sql`now()`,
        releasedBy: input.actorId ?? null,
        releaseReason: reason,
        updatedAt: sql`now()`,
      })
      .where(and(eq(suppressions.id, input.suppressionId), isNull(suppressions.releasedAt)))
      .returning();
    if (!after) throw new SuppressionNotFoundError(input.suppressionId);

    const audit = await writeAudit(tx, {
      action: 'admin.suppression_released',
      entity: 'suppression',
      entityId: input.suppressionId,
      actorType: input.actorType ?? 'user',
      actorId: input.actorId ?? null,
      before: suppressionSnapshot(current),
      after: suppressionSnapshot(after),
      reason,
      ip: input.ip ?? null,
    });

    return { suppression: after, audit };
  });
}
