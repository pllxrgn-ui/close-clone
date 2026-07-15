import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { EmailProvider, OAuthTokens } from '@switchboard/shared/providers';
import { emailAccounts, type Db } from '../../db/index.ts';
import { AccountNotFoundError, ReauthRequiredError } from './errors.ts';
import type { IngestDeps } from './ingest.ts';
import { TokenCipher } from './token-cipher.ts';
import { SyncStateService } from './state.ts';

/**
 * Shared dependency bundle for the sync workers (backfill + incremental). The
 * engine is provider-agnostic — it holds an `EmailProvider` (mock or Gmail), the
 * token `cipher` (to decrypt `email_accounts.oauth_tokens`), the state service,
 * and the ingest deps (matcher + post-persist hook).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface SyncEngineDeps {
  db: Db;
  provider: EmailProvider;
  cipher: TokenCipher;
  state: SyncStateService;
  ingest: IngestDeps;
}

/** Persisted-per-page backfill checkpoint (CONTRACTS §C5). */
export const backfillCheckpointSchema = z.object({
  /** Token to pass to `listMessages` for the NEXT page; absent ⇒ start at page 0. */
  pageToken: z.string().optional(),
  /** Messages seen so far across completed pages (progress telemetry). */
  importedCount: z.number().int().nonnegative(),
});
export type BackfillCheckpoint = z.infer<typeof backfillCheckpointSchema>;

export interface LoadedAccount {
  id: string;
  address: string;
  tokens: OAuthTokens;
  historyCursor: string | null;
  checkpoint: BackfillCheckpoint | null;
}

/**
 * Load an account and decrypt its tokens. Throws `AccountNotFoundError` if the
 * row is gone, `ReauthRequiredError` if it carries no stored tokens (never linked
 * or refresh token wiped).
 */
export async function loadAccount(deps: SyncEngineDeps, accountId: string): Promise<LoadedAccount> {
  const rows = await deps.db
    .select({
      id: emailAccounts.id,
      address: emailAccounts.address,
      oauthTokens: emailAccounts.oauthTokens,
      historyCursor: emailAccounts.historyCursor,
      backfillCheckpoint: emailAccounts.backfillCheckpoint,
    })
    .from(emailAccounts)
    .where(eq(emailAccounts.id, accountId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new AccountNotFoundError(accountId);
  if (row.oauthTokens === null) throw new ReauthRequiredError(accountId);

  const tokens = deps.cipher.decrypt(row.oauthTokens);
  const checkpoint =
    row.backfillCheckpoint === null ? null : backfillCheckpointSchema.parse(row.backfillCheckpoint);

  return {
    id: row.id,
    address: row.address,
    tokens,
    historyCursor: row.historyCursor,
    checkpoint,
  };
}
