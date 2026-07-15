import { eq, sql } from 'drizzle-orm';
import {
  HistoryExpiredError,
  MessageNotFoundError,
  type RawEmail,
} from '@switchboard/shared/providers';
import { emailAccounts, type Db } from '../../db/index.ts';
import { runBackfill } from './backfill.ts';
import { loadAccount, type SyncEngineDeps } from './engine-deps.ts';
import { ingestMessage } from './ingest.ts';
import { SyncError } from './errors.ts';

/**
 * Incremental pull worker (CONTRACTS §C5, ARCHITECTURE §3 LIVE / RESYNC).
 *
 * From the stored `history_cursor`, walk `listHistory` pages in `historyId`
 * order. Each page's message writes AND the cursor advance to that page's
 * `historyId` commit in ONE transaction — so replays are no-ops by construction
 * (dedupe + monotonic cursor), and a crash mid-walk resumes from the last
 * committed cursor.
 *
 * A `HistoryExpiredError` (cursor older than the provider's retained history)
 * drives the RESYNC path: transition LIVE→RESYNC, re-run backfill in dedupe-only
 * mode (wipes nothing, inserts only unseen messages, snapshots a fresh cursor),
 * which completes RESYNC→LIVE.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface PullResult {
  /** True iff a HistoryExpiredError forced a RESYNC re-backfill. */
  resynced: boolean;
  /** History pages applied (0 when resynced before the first apply). */
  pagesApplied: number;
  /** Messages newly inserted (dedupe applied) across this pull. */
  messagesApplied: number;
}

async function fetchAdds(
  deps: SyncEngineDeps,
  tokens: Parameters<SyncEngineDeps['provider']['getMessage']>[0],
  providerMessageIds: string[],
): Promise<RawEmail[]> {
  const raws: RawEmail[] = [];
  for (const id of providerMessageIds) {
    try {
      raws.push(await deps.provider.getMessage(tokens, id));
    } catch (err) {
      // Message deleted between the history record and the fetch — the add is
      // moot; skip it (the eventual delete record is a no-op here too).
      if (err instanceof MessageNotFoundError) continue;
      throw err;
    }
  }
  return raws;
}

/**
 * Run one incremental pull to the caught-up cursor (or trigger RESYNC). The
 * account must be LIVE with a non-null `history_cursor` (set at backfill
 * completion).
 */
export async function incrementalPull(
  deps: SyncEngineDeps,
  accountId: string,
): Promise<PullResult> {
  const account = await loadAccount(deps, accountId);
  if (account.historyCursor === null) {
    throw new SyncError(`account ${accountId} has no history cursor; backfill first`);
  }

  let cursor = account.historyCursor;
  let pagesApplied = 0;
  let messagesApplied = 0;

  for (;;) {
    let page;
    try {
      page = await deps.provider.listHistory(account.tokens, cursor);
    } catch (err) {
      if (err instanceof HistoryExpiredError) {
        await deps.state.transition(accountId, 'RESYNC', 'history:expired');
        await runBackfill(deps, accountId, { dedupeOnly: true });
        return { resynced: true, pagesApplied, messagesApplied };
      }
      throw err;
    }

    const raws = await fetchAdds(
      deps,
      account.tokens,
      page.messagesAdded.map((m) => m.providerMessageId),
    );
    const pageHistoryId = page.historyId;

    const inserted = await deps.db.transaction(async (txRaw) => {
      const tx = txRaw as Db;
      let count = 0;
      for (const raw of raws) {
        const res = await ingestMessage(tx, deps.ingest, accountId, raw);
        if (res.inserted) count += 1;
      }
      // Cursor advance IN THE SAME TRANSACTION as the writes (§C5).
      await tx
        .update(emailAccounts)
        .set({ historyCursor: pageHistoryId, updatedAt: sql`now()` })
        .where(eq(emailAccounts.id, accountId));
      return count;
    });

    cursor = pageHistoryId;
    pagesApplied += 1;
    messagesApplied += inserted;
    if (page.nextPageToken === undefined) break;
  }

  return { resynced: false, pagesApplied, messagesApplied };
}
