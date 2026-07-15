import { and, eq, sql } from 'drizzle-orm';
import type { EmailProvider } from '@switchboard/shared/providers';
import { emailProviderValues } from '@switchboard/shared';
import { emailAccounts, type Db } from '../../db/index.ts';
import { AccountNotFoundError } from './errors.ts';
import { SyncStateService } from './state.ts';
import { TokenCipher } from './token-cipher.ts';

/**
 * OAuth mailbox linking (CONTRACTS §C5 UNLINKED→AUTHORIZING→BACKFILLING).
 *
 * `startLinking` provisions (or re-uses) the `email_accounts` row, moves it to
 * AUTHORIZING, and returns the provider auth URL. `completeLinking` exchanges the
 * code, stores the tokens ENCRYPTED (§C1), and moves the account to BACKFILLING —
 * the token write and the transition commit in one transaction. Kicking off the
 * actual import is the caller's job (a worker, or `runBackfill` inline under
 * MOCK_MODE where no queue exists).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

type EmailProviderName = (typeof emailProviderValues)[number];

export interface LinkingDeps {
  db: Db;
  provider: EmailProvider;
  cipher: TokenCipher;
  state: SyncStateService;
}

export interface StartLinkingInput {
  userId: string;
  address: string;
  provider: EmailProviderName;
  redirectUri: string;
}

export interface StartLinkingResult {
  accountId: string;
  authUrl: string;
}

/**
 * Provision-or-reuse the mailbox row and move it to AUTHORIZING. A brand-new row
 * is created UNLINKED then transitioned; an existing UNLINKED / REAUTH_REQUIRED
 * row is transitioned in place. Any other current state (e.g. LIVE) makes the
 * transition illegal — surfaced by `SyncStateService`.
 */
export async function startLinking(
  deps: LinkingDeps,
  input: StartLinkingInput,
): Promise<StartLinkingResult> {
  const existing = await deps.db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.userId, input.userId), eq(emailAccounts.address, input.address)))
    .limit(1);

  let accountId: string;
  const found = existing[0];
  if (found === undefined) {
    const inserted = await deps.db
      .insert(emailAccounts)
      .values({
        userId: input.userId,
        address: input.address,
        provider: input.provider,
        syncStatus: 'UNLINKED',
      })
      .returning({ id: emailAccounts.id });
    const row = inserted[0];
    if (row === undefined) throw new Error('startLinking: account insert returned no row');
    accountId = row.id;
  } else {
    accountId = found.id;
  }

  await deps.state.transition(accountId, 'AUTHORIZING', 'oauth:start');
  const authUrl = await deps.provider.getAuthUrl(input.address, input.redirectUri);
  return { accountId, authUrl };
}

export interface CompleteLinkingInput {
  accountId: string;
  code: string;
  redirectUri: string;
}

/**
 * Exchange the OAuth code, store the encrypted tokens, and move the account to
 * BACKFILLING. Token write + transition are atomic. Returns the account id so the
 * caller can drive the backfill.
 */
export async function completeLinking(
  deps: LinkingDeps,
  input: CompleteLinkingInput,
): Promise<{ accountId: string }> {
  const exists = await deps.db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(eq(emailAccounts.id, input.accountId))
    .limit(1);
  if (exists[0] === undefined) throw new AccountNotFoundError(input.accountId);

  const tokens = await deps.provider.exchangeCode(input.code, input.redirectUri);
  const encrypted = deps.cipher.encrypt(tokens);

  await deps.db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    await tx
      .update(emailAccounts)
      .set({ oauthTokens: encrypted, updatedAt: sql`now()` })
      .where(eq(emailAccounts.id, input.accountId));
    await deps.state.transition(input.accountId, 'BACKFILLING', 'oauth:complete', tx);
  });

  return { accountId: input.accountId };
}
