import { asc, eq, sql } from 'drizzle-orm';
import type { EmailProvider } from '@switchboard/shared/providers';
import {
  activities,
  emailAccounts,
  emailMessages,
  emailThreads,
  leads,
  users,
  type Db,
} from '../../db/index.ts';
import { AmbiguousLeadMatcher, type LeadMatcher } from './matcher.ts';
import { SyncStateService } from './state.ts';
import { TokenCipher } from './token-cipher.ts';
import type { BackfillCheckpoint, SyncEngineDeps } from './engine-deps.ts';

/**
 * Shared fixtures for the sync suites. NOT a test file — helpers only: seed a
 * user + mailbox, build `SyncEngineDeps`, and produce canonicalized dumps of the
 * three affected tables for the I-SYNC byte-identity comparison (CONTRACTS §C5).
 */

export const TEST_TOKEN_SECRET = 'sync-suite-secret';

export async function seedUser(db: Db, email = 'rep@example.com'): Promise<string> {
  const rows = await db
    .insert(users)
    .values({ email, name: 'Rep', role: 'rep', idpSubject: `idp|${email}` })
    .returning({ id: users.id });
  const row = rows[0];
  if (row === undefined) throw new Error('seedUser failed');
  return row.id;
}

export async function seedLead(db: Db, name = 'Acme'): Promise<string> {
  const rows = await db.insert(leads).values({ name }).returning({ id: leads.id });
  const row = rows[0];
  if (row === undefined) throw new Error('seedLead failed');
  return row.id;
}

export interface SeedAccountInput {
  userId: string;
  address?: string;
  syncStatus?: (typeof emailAccounts.$inferInsert)['syncStatus'];
  encryptedTokens?: string | null;
  historyCursor?: string | null;
  checkpoint?: BackfillCheckpoint | null;
}

export async function seedAccount(db: Db, input: SeedAccountInput): Promise<string> {
  const rows = await db
    .insert(emailAccounts)
    .values({
      userId: input.userId,
      address: input.address ?? 'rep@mock.test',
      provider: 'mock',
      syncStatus: input.syncStatus ?? 'UNLINKED',
      oauthTokens: input.encryptedTokens ?? null,
      historyCursor: input.historyCursor ?? null,
      backfillCheckpoint: input.checkpoint ?? null,
    })
    .returning({ id: emailAccounts.id });
  const row = rows[0];
  if (row === undefined) throw new Error('seedAccount failed');
  return row.id;
}

export function makeCipher(): TokenCipher {
  return new TokenCipher(TEST_TOKEN_SECRET);
}

export function makeEngine(
  db: Db,
  provider: EmailProvider,
  matcher: LeadMatcher = new AmbiguousLeadMatcher(),
): SyncEngineDeps {
  return {
    db,
    provider,
    cipher: makeCipher(),
    state: new SyncStateService(db),
    ingest: { matcher },
  };
}

// --- Canonical dumps (I-SYNC byte-identity, modulo uuid ordering) ------------

export interface CanonicalDump {
  threads: unknown[];
  messages: unknown[];
  activities: unknown[];
}

/**
 * Dump the three affected tables in a form independent of row uuids and insert
 * order: threads keyed by `provider_thread_id`, messages keyed by
 * `rfc_message_id` with their thread referenced by its provider id, activities by
 * their stable content. Two runs that are I-SYNC-equivalent produce deep-equal
 * dumps.
 *
 * Threads carry no `account_id` column (CONTRACTS §C1); a thread belongs to an
 * account through its messages. The threads query is therefore scoped to the
 * account under test via an EXISTS on `email_messages` — exactly as the messages
 * query filters by `account_id` — so a shared test DB holding several scenarios'
 * accounts still yields a per-account dump. (Task 2b's global thread upsert made
 * this scoping unnecessary by reusing one thread row per provider-thread-id across
 * accounts; 2c threads per account, so the scope is now load-bearing.)
 */
export async function canonicalDump(db: Db, accountId: string): Promise<CanonicalDump> {
  const threadRows = await db
    .select({
      providerThreadId: emailThreads.providerThreadId,
      subjectNorm: emailThreads.subjectNorm,
      participants: emailThreads.participants,
      triageStatus: emailThreads.triageStatus,
      leadId: emailThreads.leadId,
    })
    .from(emailThreads)
    .where(
      sql`exists (select 1 from ${emailMessages} where ${emailMessages.threadId} = ${emailThreads.id} and ${emailMessages.accountId} = ${accountId})`,
    )
    .orderBy(asc(emailThreads.providerThreadId));

  const messageRows = await db
    .select({
      rfcMessageId: emailMessages.rfcMessageId,
      providerMessageId: emailMessages.providerMessageId,
      direction: emailMessages.direction,
      fromAddr: emailMessages.fromAddr,
      subject: emailMessages.subject,
      snippet: emailMessages.snippet,
      sentAt: emailMessages.sentAt,
      inReplyTo: emailMessages.inReplyTo,
      refs: emailMessages.refs,
      toAddrs: emailMessages.toAddrs,
      cc: emailMessages.cc,
      threadProviderId: emailThreads.providerThreadId,
    })
    .from(emailMessages)
    .innerJoin(emailThreads, eq(emailMessages.threadId, emailThreads.id))
    .where(eq(emailMessages.accountId, accountId))
    .orderBy(asc(emailMessages.rfcMessageId));

  const activityRows = await db
    .select({
      type: activities.type,
      leadId: activities.leadId,
      occurredAt: activities.occurredAt,
      payload: activities.payload,
    })
    .from(activities)
    .orderBy(asc(activities.type), asc(activities.occurredAt));

  return { threads: threadRows, messages: messageRows, activities: activityRows };
}
