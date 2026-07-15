import { eq, sql } from 'drizzle-orm';
import { emailAccounts, syncEvents, type Db } from '../../db/index.ts';
import { AccountNotFoundError, IllegalTransitionError, type SyncStatus } from './errors.ts';

/**
 * SyncStateService — the SOLE mutator of `email_accounts.sync_status`
 * (CONTRACTS §C5). Every transition is validated against the C5 adjacency below,
 * applied to the account row, and appended to `sync_events` (from_state,
 * to_state, cause) atomically. No other module writes `sync_status`.
 *
 * C5 state machine:
 *   UNLINKED → AUTHORIZING → BACKFILLING → LIVE ⇄ DEGRADED
 *   LIVE → RESYNC → LIVE
 *   (any) → REAUTH_REQUIRED → AUTHORIZING
 *
 * Transitions run inside a transaction: either a caller-supplied `tx` (so a
 * worker advances state IN THE SAME TRANSACTION as its cursor/message writes —
 * §C5), or a fresh one. The current state is read `FOR UPDATE`, closing the
 * concurrent-transition race at the serialization level.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** Per-source-state allowed targets, excluding the universal REAUTH escape. */
const ALLOWED: Readonly<Record<SyncStatus, readonly SyncStatus[]>> = {
  UNLINKED: ['AUTHORIZING'],
  AUTHORIZING: ['BACKFILLING'],
  BACKFILLING: ['LIVE'],
  LIVE: ['DEGRADED', 'RESYNC'],
  DEGRADED: ['LIVE'],
  RESYNC: ['LIVE'],
  REAUTH_REQUIRED: ['AUTHORIZING'],
};

/** REAUTH_REQUIRED is reachable from ANY state (refresh token can die anytime). */
const UNIVERSAL_TARGET: SyncStatus = 'REAUTH_REQUIRED';

/** True iff the C5 machine permits `from → to`. */
export function isLegalTransition(from: SyncStatus, to: SyncStatus): boolean {
  if (to === UNIVERSAL_TARGET) return from !== UNIVERSAL_TARGET;
  return ALLOWED[from].includes(to);
}

export interface TransitionResult {
  from: SyncStatus;
  to: SyncStatus;
}

/** A drizzle transaction handle or a plain db — both satisfy the query surface. */
type Executor = Db;

async function applyTransition(
  exec: Executor,
  accountId: string,
  to: SyncStatus,
  cause: string,
): Promise<TransitionResult> {
  // Lock the row so a concurrent transition serialises behind us (§C5 race).
  const rows = await exec
    .select({ status: emailAccounts.syncStatus })
    .from(emailAccounts)
    .where(eq(emailAccounts.id, accountId))
    .for('update');
  const current = rows[0];
  if (current === undefined) throw new AccountNotFoundError(accountId);

  const from = current.status;
  if (!isLegalTransition(from, to)) throw new IllegalTransitionError(from, to);

  await exec
    .update(emailAccounts)
    .set({ syncStatus: to, updatedAt: sql`now()` })
    .where(eq(emailAccounts.id, accountId));

  await exec.insert(syncEvents).values({ accountId, fromState: from, toState: to, cause });

  return { from, to };
}

export class SyncStateService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Transition `accountId` to `to` with `cause`, writing a `sync_events` row.
   * Pass `tx` to run inside an existing transaction (worker cursor atomicity);
   * omit it to run in a fresh transaction.
   */
  async transition(
    accountId: string,
    to: SyncStatus,
    cause: string,
    tx?: Db,
  ): Promise<TransitionResult> {
    if (tx !== undefined) return applyTransition(tx, accountId, to, cause);
    return this.db.transaction((t) => applyTransition(t as Db, accountId, to, cause));
  }

  /** Current persisted state (throws if the account is gone). */
  async current(accountId: string): Promise<SyncStatus> {
    const rows = await this.db
      .select({ status: emailAccounts.syncStatus })
      .from(emailAccounts)
      .where(eq(emailAccounts.id, accountId));
    const row = rows[0];
    if (row === undefined) throw new AccountNotFoundError(accountId);
    return row.status;
  }
}
