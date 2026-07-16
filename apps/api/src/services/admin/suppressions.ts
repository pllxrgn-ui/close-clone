import { and, desc, eq, isNull, isNotNull, lt, or, type SQL } from 'drizzle-orm';
import type { Suppression } from '@switchboard/shared';
import { suppressions, type Db } from '../../db/index.ts';
import {
  MissingReasonError,
  SuppressionAlreadyReleasedError,
  SuppressionNotFoundError,
  releaseSuppression,
} from '../audit/index.ts';
import { addEmailSuppression } from '../sequences/suppression.ts';
import { addPhoneSuppression } from '../telephony/suppression.ts';
import { phoneMatchKey } from '../telephony/phone.ts';
import { AdminConflictError, AdminNotFoundError, AdminValidationError } from './errors.ts';
import type { AdminActor } from './types.ts';

/**
 * Admin suppression surface (CONTRACTS §C1 `suppressions`, §C6, §C7 `admin/*`).
 *
 *   - GET  /admin/suppressions          — keyset list, newest first, optional
 *     kind/active filters.
 *   - POST /admin/suppressions          — ADD a global block. Adding is always
 *     rail-safe (it tightens compliance, never loosens it); it routes through the
 *     engine's idempotent add helpers (`source: 'manual'`), never a raw insert
 *     that could skip the `(kind, value)` normalization.
 *   - POST /admin/suppressions/:id/release — the ONE blessed release path, reusing
 *     `releaseSuppression` (5b/5g): reason REQUIRED, audited atomically.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const SELECT_COLS = {
  id: suppressions.id,
  kind: suppressions.kind,
  value: suppressions.value,
  source: suppressions.source,
  reason: suppressions.reason,
  createdBy: suppressions.createdBy,
  releasedAt: suppressions.releasedAt,
  releasedBy: suppressions.releasedBy,
  releaseReason: suppressions.releaseReason,
  createdAt: suppressions.createdAt,
  updatedAt: suppressions.updatedAt,
} as const;

function toIso(value: string): string {
  return new Date(value).toISOString();
}
function toIsoN(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toDto(r: {
  id: string;
  kind: 'email' | 'phone';
  value: string;
  source: Suppression['source'];
  reason: string | null;
  createdBy: string | null;
  releasedAt: string | null;
  releasedBy: string | null;
  releaseReason: string | null;
  createdAt: string;
  updatedAt: string;
}): Suppression {
  return {
    id: r.id,
    kind: r.kind,
    value: r.value,
    source: r.source,
    reason: r.reason,
    createdBy: r.createdBy,
    releasedAt: toIsoN(r.releasedAt),
    releasedBy: r.releasedBy,
    releaseReason: r.releaseReason,
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
  };
}

// --- Opaque keyset cursor over (created_at desc, id desc) -------------------

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { createdAt?: unknown }).createdAt === 'string' &&
      typeof (parsed as { id?: unknown }).id === 'string'
    ) {
      return parsed as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}

export interface ListSuppressionsInput {
  limit?: number;
  cursor?: string;
  kind?: 'email' | 'phone';
  /** true → only active (not released); false → only released; omit → all. */
  active?: boolean;
}

export interface SuppressionPage {
  items: Suppression[];
  nextCursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Keyset page of suppressions, newest first. */
export async function listSuppressions(
  db: Db,
  input: ListSuppressionsInput = {},
): Promise<SuppressionPage> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const conds: SQL[] = [];
  if (input.kind !== undefined) conds.push(eq(suppressions.kind, input.kind));
  if (input.active === true) conds.push(isNull(suppressions.releasedAt));
  if (input.active === false) conds.push(isNotNull(suppressions.releasedAt));

  if (input.cursor !== undefined) {
    const c = decodeCursor(input.cursor);
    if (c === null) throw new AdminValidationError('invalid cursor', { field: 'cursor' });
    // (created_at, id) < (cursor.created_at, cursor.id) in DESC order.
    const after = or(
      lt(suppressions.createdAt, c.createdAt),
      and(eq(suppressions.createdAt, c.createdAt), lt(suppressions.id, c.id)),
    );
    if (after !== undefined) conds.push(after);
  }

  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
  const rows = await db
    .select(SELECT_COLS)
    .from(suppressions)
    .where(where)
    .orderBy(desc(suppressions.createdAt), desc(suppressions.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const items = page.map(toDto);
  const result: SuppressionPage = { items };
  if (rows.length > limit) {
    const last = page[page.length - 1]!;
    result.nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.id });
  }
  return result;
}

export interface AddSuppressionInput {
  kind: unknown;
  value: unknown;
  reason?: unknown;
}

/**
 * Add (or re-activate) a global suppression via the engine add helpers. Returns
 * the resulting row. For phone kinds the value is normalized to the trailing-10-
 * digit match key (the same key the dial/SMS rails probe).
 */
export async function addSuppression(
  db: Db,
  input: AddSuppressionInput,
  actor: AdminActor,
): Promise<Suppression> {
  if (input.kind !== 'email' && input.kind !== 'phone') {
    throw new AdminValidationError('kind must be email or phone', { field: 'kind' });
  }
  const rawValue = typeof input.value === 'string' ? input.value.trim() : '';
  if (rawValue.length === 0) {
    throw new AdminValidationError('value is required', { field: 'value' });
  }
  const reason =
    typeof input.reason === 'string' && input.reason.trim().length > 0
      ? input.reason.trim()
      : undefined;

  let suppressionId: string;
  if (input.kind === 'email') {
    const res = await addEmailSuppression(db, {
      value: rawValue,
      source: 'manual',
      ...(reason !== undefined ? { reason } : {}),
      ...(actor.id !== null ? { createdBy: actor.id } : {}),
    });
    suppressionId = res.suppressionId;
  } else {
    const key = phoneMatchKey(rawValue);
    if (key === '') {
      throw new AdminValidationError('value must be a phone number with at least 10 digits', {
        field: 'value',
      });
    }
    const res = await addPhoneSuppression(db, {
      key,
      source: 'manual',
      ...(reason !== undefined ? { reason } : {}),
      ...(actor.id !== null ? { createdBy: actor.id } : {}),
    });
    suppressionId = res.suppressionId;
  }

  const rows = await db
    .select(SELECT_COLS)
    .from(suppressions)
    .where(eq(suppressions.id, suppressionId))
    .limit(1);
  return toDto(rows[0]!);
}

export interface ReleaseSuppressionInput {
  reason: unknown;
}

/**
 * Release a suppression through the blessed audited path. Maps the engine's typed
 * errors onto the admin taxonomy (missing reason → 400, unknown id → 404, already
 * released → 409).
 */
export async function releaseSuppressionById(
  db: Db,
  id: string,
  input: ReleaseSuppressionInput,
  actor: AdminActor,
): Promise<Suppression> {
  const reason = typeof input.reason === 'string' ? input.reason : '';
  try {
    const { suppression } = await releaseSuppression(db, {
      suppressionId: id,
      reason,
      actorId: actor.id,
      actorType: actor.type,
      ip: actor.ip,
    });
    return toDto({
      id: suppression.id,
      kind: suppression.kind,
      value: suppression.value,
      source: suppression.source,
      reason: suppression.reason,
      createdBy: suppression.createdBy,
      releasedAt: suppression.releasedAt,
      releasedBy: suppression.releasedBy,
      releaseReason: suppression.releaseReason,
      createdAt: suppression.createdAt,
      updatedAt: suppression.updatedAt,
    });
  } catch (err) {
    if (err instanceof MissingReasonError) {
      throw new AdminValidationError('a reason is required to release a suppression', {
        field: 'reason',
      });
    }
    if (err instanceof SuppressionNotFoundError) {
      throw new AdminNotFoundError('Suppression not found');
    }
    if (err instanceof SuppressionAlreadyReleasedError) {
      throw new AdminConflictError('Suppression is already released');
    }
    throw err;
  }
}
