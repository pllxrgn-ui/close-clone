import { eq, sql } from 'drizzle-orm';
import type { RawEmail } from '@switchboard/shared/providers';
import { emailAccounts, type Db } from '../../db/index.ts';
import {
  loadAccount,
  type BackfillCheckpoint,
  type SyncEngineDeps,
} from './engine-deps.ts';
import { ingestMessage } from './ingest.ts';

/**
 * Full-history backfill worker (CONTRACTS §C5, ARCHITECTURE §3 BACKFILLING).
 *
 * Paged `listMessages` import. After EVERY page, the ingested messages AND the
 * checkpoint `(pageToken, importedCount)` commit in one transaction, so a restart
 * resumes from the saved token and never re-walks completed pages. On the last
 * page, the same transaction clears the checkpoint, snapshots the page's
 * `historyId` as the live cursor, and transitions the account to LIVE — so the
 * BACKFILLING→LIVE handoff and the cursor are atomic (a crash after the last page
 * either sees the completed LIVE state or replays the last page harmlessly).
 *
 * `dedupeOnly` is cosmetic: every page ingests through the same
 * `ON CONFLICT DO NOTHING` path, so a RESYNC re-backfill inserts only unseen
 * messages and rewrites nothing (ARCHITECTURE §3 RESYNC). The flag exists so the
 * completion cause string records why the backfill ran.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface BackfillStepResult {
  /** True when this page was the last — the account is now LIVE. */
  done: boolean;
  /** Cumulative messages seen across completed pages. */
  importedCount: number;
  /** Messages newly inserted by THIS page (dedupe applied). */
  insertedThisPage: number;
}

export interface BackfillOptions {
  /** RESYNC re-run (dedupe-only); only affects the completion cause string. */
  dedupeOnly?: boolean;
}

function completionCause(dedupeOnly: boolean): string {
  return dedupeOnly ? 'resync:backfill-complete' : 'backfill:complete';
}

/**
 * Process exactly one backfill page. Returns `done: true` once the final page has
 * committed. Callers loop until done (see {@link runBackfill}); processing one
 * page at a time is what makes crash-resume observable and testable.
 */
export async function backfillStep(
  deps: SyncEngineDeps,
  accountId: string,
  options: BackfillOptions = {},
): Promise<BackfillStepResult> {
  const account = await loadAccount(deps, accountId);
  const pageToken = account.checkpoint?.pageToken;
  const priorCount = account.checkpoint?.importedCount ?? 0;

  const page = await deps.provider.listMessages(account.tokens, pageToken);

  // Fetch each message body OUTSIDE the transaction (network), then commit the
  // whole page atomically.
  const raws: RawEmail[] = [];
  for (const ref of page.messages) {
    raws.push(await deps.provider.getMessage(account.tokens, ref.providerMessageId));
  }

  const importedCount = priorCount + raws.length;
  const nextToken = page.nextPageToken;
  const done = nextToken === undefined;

  const insertedThisPage = await deps.db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    let inserted = 0;
    for (const raw of raws) {
      const res = await ingestMessage(tx, deps.ingest, accountId, raw);
      if (res.inserted) inserted += 1;
    }

    if (done) {
      // Final page: clear checkpoint, snapshot live cursor, go LIVE — atomically.
      await tx
        .update(emailAccounts)
        .set({ backfillCheckpoint: null, historyCursor: page.historyId, updatedAt: sql`now()` })
        .where(eq(emailAccounts.id, accountId));
      await deps.state.transition(accountId, 'LIVE', completionCause(options.dedupeOnly ?? false), tx);
    } else {
      const checkpoint: BackfillCheckpoint = { pageToken: nextToken, importedCount };
      await tx
        .update(emailAccounts)
        .set({ backfillCheckpoint: checkpoint, updatedAt: sql`now()` })
        .where(eq(emailAccounts.id, accountId));
    }
    return inserted;
  });

  return { done, importedCount, insertedThisPage };
}

/**
 * Run backfill to completion, resuming from any persisted checkpoint. Returns the
 * total messages seen. Idempotent end-to-end: a re-run after completion (state
 * already LIVE, checkpoint cleared) would still walk from page 0 under dedupe —
 * callers gate invocation on BACKFILLING/RESYNC state.
 */
export async function runBackfill(
  deps: SyncEngineDeps,
  accountId: string,
  options: BackfillOptions = {},
): Promise<number> {
  let total = 0;
  for (;;) {
    const step = await backfillStep(deps, accountId, options);
    total = step.importedCount;
    if (step.done) break;
  }
  return total;
}
