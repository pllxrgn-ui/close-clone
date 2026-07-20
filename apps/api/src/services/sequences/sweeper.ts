import { and, eq, lte, sql } from 'drizzle-orm';
import { emailAccounts, sendIntents, type Db } from '../../db/index.ts';
import { runBackfill, type SyncEngineDeps } from '../sync/index.ts';
import type { QueueDriver } from '../../queue/index.ts';
import { SEND_JOB_NAME, wakeupJobId } from './job-names.ts';

/**
 * The sweeper (ARCHITECTURE §4.2/§4.3) — the self-heal + crash-recovery loop:
 *
 *   1. {@link sweepDueIntents}: enqueue a wake-up for every due SCHEDULED intent
 *      that may be missing a job (lost BullMQ delayed job, process restart). The
 *      per-intent jobId dedupes against a live wake-up, so this is safe to run
 *      every minute.
 *   2. {@link expireStaleClaims}: a CLAIMED intent older than the claim timeout is
 *      a crash between claim and SENT — expire it to FAILED_TIMEOUT. It is NEVER
 *      auto-re-sent (CONTRACTS §C6): the provider may or may not have delivered it,
 *      and only the idempotency key (= intent id) makes a deliberate retry safe.
 *   3. {@link recoverResyncAccounts}: an account stuck in RESYNC (worker died
 *      mid-re-backfill) must be re-driven via `runBackfill` DIRECTLY — re-driving
 *      incremental pull would raise IllegalTransitionError (RESYNC→RESYNC is
 *      illegal). Assigned to 2e's sweeper by DECISIONS D-023 / the 2b note.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface SweeperDeps {
  db: Db;
  queue: QueueDriver;
  now: () => Date;
  /** A CLAIMED intent older than this (ms) is expired to FAILED_TIMEOUT. */
  claimTimeoutMs: number;
}

/** Enqueue wake-ups for all due SCHEDULED intents. Returns the count enqueued. */
export async function sweepDueIntents(deps: SweeperDeps): Promise<number> {
  const nowIso = deps.now().toISOString();
  const due = await deps.db
    .select({ id: sendIntents.id, dueAt: sendIntents.dueAt })
    .from(sendIntents)
    .where(and(eq(sendIntents.state, 'SCHEDULED'), lte(sendIntents.dueAt, nowIso)));
  for (const row of due) {
    // Same (id, due_at) as the enroller's wake-up → dedupes; a deferred intent's
    // advanced due_at yields a fresh id (see wakeupJobId).
    await deps.queue.enqueue(
      SEND_JOB_NAME,
      { intentId: row.id },
      { jobId: wakeupJobId(row.id, new Date(row.dueAt).getTime()) },
    );
  }
  return due.length;
}

/** Expire CLAIMED intents whose claim is older than the timeout → FAILED_TIMEOUT. */
export async function expireStaleClaims(deps: SweeperDeps): Promise<string[]> {
  const cutoffIso = new Date(deps.now().getTime() - deps.claimTimeoutMs).toISOString();
  const expired = await deps.db
    .update(sendIntents)
    .set({ state: 'FAILED_TIMEOUT', skipReason: 'claim_timeout', updatedAt: sql`now()` })
    .where(and(eq(sendIntents.state, 'CLAIMED'), lte(sendIntents.claimedAt, cutoffIso)))
    .returning({ id: sendIntents.id });
  return expired.map((r) => r.id);
}

/**
 * Re-drive every account left in RESYNC via `runBackfill` (dedupe-only). Each
 * account's backfill transitions it RESYNC→LIVE on completion. Returns the account
 * ids recovered. Errors on one account do not abort the others.
 */
export async function recoverResyncAccounts(syncDeps: SyncEngineDeps): Promise<string[]> {
  const stuck = await syncDeps.db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(eq(emailAccounts.syncStatus, 'RESYNC'));
  const recovered: string[] = [];
  for (const account of stuck) {
    await runBackfill(syncDeps, account.id, { dedupeOnly: true });
    recovered.push(account.id);
  }
  return recovered;
}
