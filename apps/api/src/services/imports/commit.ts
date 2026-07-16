import { and, eq, sql } from 'drizzle-orm';

import { contacts, imports, leads, type Db } from '../../db/index.ts';
import { recordActivity } from '../activity/writer.ts';
import type { CommitCounters, CommitResult, ImportPlan, RowPlan } from './types.ts';

/**
 * Transactional committer (Task 4f). Replays the persisted dry-run `ImportPlan`
 * (NOT a fresh dedupe pass — decisions are identical to dry-run by construction)
 * in atomic batches. Each batch, in one transaction: inserts the batch's leads +
 * contacts (idempotent via ON CONFLICT DO NOTHING on the pre-assigned ids),
 * fills merge-target fields, emits `import_created` + `lead_created` for every
 * created lead through the sole write path (ActivityWriter), and advances the
 * checkpoint in `imports.result` — so a crash between batches resumes at a batch
 * boundary with no duplicate rows.
 *
 * Idempotency + concurrency (CONTRACTS §C8):
 *   - status 'committed' → AlreadyCommittedError (re-POST is a no-op CONFLICT);
 *   - status 'committing' with a fresh lease (another committer) → CommitInProgressError;
 *   - status 'committing' with a stale lease (crashed) or the same committer → RESUME;
 *   - status 'dry_run' → fresh commit (claimed via a compare-and-swap on status);
 *   - status 'uploaded'/'mapped'/'failed' → ImportNotCommittableError.
 *
 * Suppressed contact emails are imported + flagged by the planner and left to the
 * existing send-safety rails — this committer never enrolls or contacts, so it
 * duplicates no rail logic.
 *
 * Import-safe for direct `node` execution (no enums / namespaces).
 */

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_LEASE_TTL_MS = 60_000;

// --- Errors ----------------------------------------------------------------

export class CommitError extends Error {
  readonly importId: string;
  constructor(name: string, message: string, importId: string) {
    super(message);
    this.name = name;
    this.importId = importId;
  }
}
export class ImportNotFoundError extends CommitError {
  constructor(importId: string) {
    super('ImportNotFoundError', `import ${importId} not found`, importId);
  }
}
export class AlreadyCommittedError extends CommitError {
  constructor(importId: string) {
    super('AlreadyCommittedError', `import ${importId} is already committed`, importId);
  }
}
export class CommitInProgressError extends CommitError {
  constructor(importId: string) {
    super('CommitInProgressError', `import ${importId} commit is already in progress`, importId);
  }
}
export class ImportNotCommittableError extends CommitError {
  readonly status: string;
  constructor(importId: string, status: string) {
    super(
      'ImportNotCommittableError',
      `import ${importId} cannot be committed from '${status}'`,
      importId,
    );
    this.status = status;
  }
}
export class ImportPlanMissingError extends CommitError {
  constructor(importId: string) {
    super('ImportPlanMissingError', `import ${importId} has no dry-run plan to commit`, importId);
  }
}

// --- Options / outcome ------------------------------------------------------

export interface CommitOptions {
  /** Stable id of the committing worker (a restart with the same id may resume). */
  committerId?: string;
  batchSize?: number;
  /** Injectable clock (lease heartbeats + activity occurred_at). */
  now?: () => Date;
  leaseTtlMs?: number;
  /** TEST SEAM: stop after N committed batches, leaving status 'committing'. */
  stopAfterBatches?: number;
}

export interface CommitOutcome {
  status: 'committed' | 'stopped';
  resumed: boolean;
  counters: CommitCounters;
  nextRowIndex: number;
}

// --- Persisted-shape helpers ------------------------------------------------

function parsePlan(value: unknown): ImportPlan {
  const v = value as Partial<ImportPlan> | null;
  if (v === null || v.version !== 1 || !Array.isArray(v.rows)) {
    throw new Error('malformed dry_run_result');
  }
  return v as ImportPlan;
}

function readCheckpoint(value: unknown): CommitResult | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<CommitResult>;
  if (typeof v.nextRowIndex !== 'number') return null;
  return v as CommitResult;
}

function zeroCounters(): CommitCounters {
  return { leads: 0, contacts: 0, merged: 0, activities: 0 };
}

/** Cross the jsonb boundary: a typed checkpoint → the column's Record shape. */
function toJson(cp: CommitResult): Record<string, unknown> {
  return cp as unknown as Record<string, unknown>;
}

function leaseIsStale(cp: CommitResult | null, nowMs: number, ttlMs: number): boolean {
  if (cp === null || cp.lease === null) return true;
  const beat = Date.parse(cp.lease.heartbeatAt);
  return Number.isNaN(beat) || nowMs - beat >= ttlMs;
}

// --- Row application --------------------------------------------------------

async function applyRow(
  tx: Db,
  row: RowPlan,
  actingUserId: string | null,
  importId: string,
  rowCount: number | null,
  occurredAt: string,
  counters: CommitCounters,
): Promise<void> {
  if (row.outcome === 'create' && row.lead !== null) {
    const l = row.lead;
    const inserted = await tx
      .insert(leads)
      .values({
        id: l.id,
        name: l.name ?? 'Unknown',
        url: l.url,
        description: l.description,
        statusId: l.statusId,
        ownerId: l.ownerId,
        dnc: l.dnc,
        custom: l.custom,
      })
      .onConflictDoNothing()
      .returning({ id: leads.id });
    // Idempotent replay: if the lead already exists, its contact + activities do
    // too — skip so a re-run never duplicates rows or events.
    if (inserted.length === 0) return;
    if (row.contact !== null) {
      await insertContact(tx, row, l.id);
      counters.contacts += 1;
    }
    // import_created + lead_created, once each, via the sole write path.
    await recordActivity(tx, {
      leadId: l.id,
      userId: actingUserId,
      type: 'import_created',
      occurredAt,
      payload: rowCount === null ? { importId } : { importId, rowCount },
    });
    await recordActivity(tx, {
      leadId: l.id,
      userId: actingUserId,
      type: 'lead_created',
      occurredAt,
      payload: {},
    });
    counters.leads += 1;
    counters.activities += 2;
    return;
  }

  if (row.outcome === 'dedupe' && row.action === 'merge-fields' && row.lead !== null) {
    const l = row.lead;
    // Fill only where the existing lead is empty; existing custom keys win, dnc
    // only ever tightens. The matched lead may have been soft-deleted since
    // dry-run — the WHERE guards it, and a no-op update is harmless.
    await tx.execute(sql`
      UPDATE ${leads}
      SET url = COALESCE(${leads.url}, ${l.url}),
          description = COALESCE(${leads.description}, ${l.description}),
          status_id = COALESCE(${leads.statusId}, ${l.statusId}),
          owner_id = COALESCE(${leads.ownerId}, ${l.ownerId}),
          dnc = ${leads.dnc} OR ${l.dnc},
          custom = ${JSON.stringify(l.custom)}::jsonb || ${leads.custom},
          updated_at = now()
      WHERE ${leads.id} = ${l.id} AND ${leads.deletedAt} IS NULL
    `);
    if (row.contact !== null) {
      await insertContact(tx, row, l.id);
      counters.contacts += 1;
    }
    counters.merged += 1;
    return;
  }
  // skip / error / empty: nothing to write.
}

async function insertContact(tx: Db, row: RowPlan, leadId: string): Promise<void> {
  const c = row.contact;
  if (c === null) return;
  await tx
    .insert(contacts)
    .values({
      id: c.id,
      leadId,
      name: c.name,
      title: c.title,
      emails: c.email === null ? [] : [{ email: c.email, type: 'work' }],
      phones: c.phone === null ? [] : [{ phone: c.phone, type: 'work' }],
    })
    .onConflictDoNothing();
}

// --- Commit driver ----------------------------------------------------------

interface ImportRowState {
  status: string;
  createdBy: string;
  rowCount: number | null;
  dryRunResult: unknown;
  result: unknown;
}

async function loadImport(db: Db, importId: string): Promise<ImportRowState | null> {
  const [row] = await db
    .select({
      status: imports.status,
      createdBy: imports.createdBy,
      rowCount: imports.rowCount,
      dryRunResult: imports.dryRunResult,
      result: imports.result,
    })
    .from(imports)
    .where(eq(imports.id, importId));
  return row ?? null;
}

/**
 * Commit an import. Idempotent + resumable per the module contract above.
 */
export async function commitImport(
  db: Db,
  importId: string,
  opts: CommitOptions = {},
): Promise<CommitOutcome> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = opts.now ?? (() => new Date());
  const leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const committerId = opts.committerId ?? 'committer';

  const row = await loadImport(db, importId);
  if (row === null) throw new ImportNotFoundError(importId);

  if (row.status === 'committed') throw new AlreadyCommittedError(importId);
  if (row.status === 'uploaded' || row.status === 'mapped' || row.status === 'failed') {
    throw new ImportNotCommittableError(importId, row.status);
  }

  const plan = (() => {
    try {
      return parsePlan(row.dryRunResult);
    } catch {
      throw new ImportPlanMissingError(importId);
    }
  })();

  const nowDate = now();
  let resumed = false;
  let startIndex = 0;
  let counters = zeroCounters();
  let startedAt = nowDate.toISOString();

  if (row.status === 'committing') {
    const cp = readCheckpoint(row.result);
    const sameCommitter = cp?.lease?.committerId === committerId;
    if (!sameCommitter && !leaseIsStale(cp, nowDate.getTime(), leaseTtlMs)) {
      throw new CommitInProgressError(importId);
    }
    resumed = true;
    startIndex = cp?.nextRowIndex ?? 0;
    counters = cp?.counters ?? zeroCounters();
    startedAt = cp?.startedAt ?? startedAt;
    // Re-claim: refresh the lease so a racing committer sees it fresh.
    await writeCheckpoint(
      db,
      importId,
      'in_progress',
      startIndex,
      counters,
      committerId,
      startedAt,
      nowDate,
    );
  } else {
    // status === 'dry_run': claim via compare-and-swap on status.
    const claimed = await db
      .update(imports)
      .set({
        status: 'committing',
        result: toJson(makeCheckpoint('in_progress', 0, counters, committerId, startedAt, nowDate)),
        updatedAt: nowDate.toISOString(),
      })
      .where(and(eq(imports.id, importId), eq(imports.status, 'dry_run')))
      .returning({ id: imports.id });
    if (claimed.length === 0) {
      // Lost the race; re-read and surface the right conflict.
      const again = await loadImport(db, importId);
      if (again?.status === 'committed') throw new AlreadyCommittedError(importId);
      throw new CommitInProgressError(importId);
    }
  }

  const total = plan.rows.length;
  let idx = startIndex;
  let batchNo = 0;
  try {
    while (idx < total) {
      const end = Math.min(idx + batchSize, total);
      const occurredAt = now().toISOString();
      const heartbeat = now();
      await db.transaction(async (tx) => {
        for (let i = idx; i < end; i += 1) {
          const r = plan.rows[i];
          if (r !== undefined) {
            await applyRow(tx, r, row.createdBy, importId, row.rowCount, occurredAt, counters);
          }
        }
        await writeCheckpoint(
          tx,
          importId,
          'in_progress',
          end,
          counters,
          committerId,
          startedAt,
          heartbeat,
        );
      });
      idx = end;
      batchNo += 1;
      if (opts.stopAfterBatches !== undefined && batchNo >= opts.stopAfterBatches && idx < total) {
        return { status: 'stopped', resumed, counters, nextRowIndex: idx };
      }
    }

    // Finalize.
    const finishedAt = now().toISOString();
    await db
      .update(imports)
      .set({
        status: 'committed',
        result: toJson({
          status: 'done',
          nextRowIndex: total,
          counters,
          lease: null,
          startedAt,
          finishedAt,
          error: null,
        }),
        updatedAt: finishedAt,
      })
      .where(eq(imports.id, importId));
    return { status: 'committed', resumed, counters, nextRowIndex: total };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(imports)
      .set({
        status: 'failed',
        error: message,
        result: toJson({
          status: 'failed',
          nextRowIndex: idx,
          counters,
          lease: null,
          startedAt,
          finishedAt: now().toISOString(),
          error: message,
        }),
        updatedAt: now().toISOString(),
      })
      .where(eq(imports.id, importId));
    throw err;
  }
}

function makeCheckpoint(
  status: CommitResult['status'],
  nextRowIndex: number,
  counters: CommitCounters,
  committerId: string,
  startedAt: string,
  heartbeat: Date,
): CommitResult {
  return {
    status,
    nextRowIndex,
    counters,
    lease: { committerId, heartbeatAt: heartbeat.toISOString() },
    startedAt,
    finishedAt: null,
    error: null,
  };
}

async function writeCheckpoint(
  db: Db,
  importId: string,
  status: CommitResult['status'],
  nextRowIndex: number,
  counters: CommitCounters,
  committerId: string,
  startedAt: string,
  heartbeat: Date,
): Promise<void> {
  await db
    .update(imports)
    .set({
      result: toJson(
        makeCheckpoint(status, nextRowIndex, counters, committerId, startedAt, heartbeat),
      ),
      updatedAt: heartbeat.toISOString(),
    })
    .where(eq(imports.id, importId));
}
