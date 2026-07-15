import { and, eq } from 'drizzle-orm';
import type { RawEmail } from '@switchboard/shared/providers';
import { emailMessages, emailThreads, type Db } from '../../db/index.ts';
import type { LeadMatcher } from './matcher.ts';

/**
 * Idempotent persistence of one fetched message into `email_threads` +
 * `email_messages` — the shared write used by both backfill and incremental pull
 * (CONTRACTS §C5 I-SYNC). Every write is a no-op on replay:
 *
 *  - the thread is upserted by `provider_thread_id` (found-or-inserted); a
 *    re-seen message finds the existing thread, never a duplicate;
 *  - the message insert is `ON CONFLICT DO NOTHING` covering BOTH unique indexes
 *    (`account_id, rfc_message_id` — the dedupe backstop — and `account_id,
 *    provider_message_id`), so a replayed or reordered message inserts once.
 *
 * `MessageHook` fires exactly once per message — only when the insert actually
 * created a row — so any downstream effect (2c's `email_received`/`email_sent`
 * activity emission on a *matched* thread) is itself replay-safe. In 2b the hook
 * defaults to a no-op and the matcher is `ambiguous`, so no activities are
 * written; the seam is what 2c fills.
 *
 * All work runs on the caller's transaction handle (`exec`) so it commits
 * atomically with the cursor/checkpoint advance.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** Post-persist side-effect seam (2c wires activity emission here). */
export type MessageHook = (
  exec: Db,
  ctx: { accountId: string; raw: RawEmail; threadId: string; leadId: string | null },
) => Promise<void>;

const NOOP_HOOK: MessageHook = async () => {};

export interface IngestDeps {
  matcher: LeadMatcher;
  onMessagePersisted?: MessageHook;
}

export interface IngestResult {
  /** True iff this call inserted a new `email_messages` row (first sighting). */
  inserted: boolean;
  threadId: string;
}

/** Strip leading Re:/Fwd:/Fw: prefixes, trim, lowercase — the thread group key. */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '').trim().toLowerCase();
}

/** Deduped, sorted participant address list (deterministic thread attribute). */
export function threadParticipants(raw: RawEmail): string[] {
  return [...new Set([raw.from, ...raw.to, ...raw.cc])].sort();
}

/**
 * Find the thread for `providerThreadId`, or create it with the matcher's triage
 * decision. Returns the thread's uuid. Serialised processing (D-013) makes the
 * find-then-insert race-free; within one transaction a same-page sibling sees the
 * just-inserted row.
 */
async function upsertThread(
  exec: Db,
  deps: IngestDeps,
  accountId: string,
  raw: RawEmail,
): Promise<{ threadId: string; leadId: string | null }> {
  const existing = await exec
    .select({ id: emailThreads.id, leadId: emailThreads.leadId })
    .from(emailThreads)
    .where(eq(emailThreads.providerThreadId, raw.threadId))
    .limit(1);
  const found = existing[0];
  if (found !== undefined) return { threadId: found.id, leadId: found.leadId };

  const subjectNorm = normalizeSubject(raw.subject);
  const participants = threadParticipants(raw);
  const decision = deps.matcher.match({ accountId, raw, subjectNorm, participants });

  const inserted = await exec
    .insert(emailThreads)
    .values({
      leadId: decision.leadId,
      subjectNorm,
      participants,
      triageStatus: decision.triageStatus,
      providerThreadId: raw.threadId,
    })
    .returning({ id: emailThreads.id });
  const row = inserted[0];
  if (row === undefined) throw new Error('ingest: thread insert returned no row');
  return { threadId: row.id, leadId: decision.leadId };
}

/**
 * Upsert one fetched message. Idempotent: safe to call for the same message any
 * number of times, in any order, across backfill and push.
 */
export async function ingestMessage(
  exec: Db,
  deps: IngestDeps,
  accountId: string,
  raw: RawEmail,
): Promise<IngestResult> {
  const { threadId, leadId } = await upsertThread(exec, deps, accountId, raw);

  const insertedRows = await exec
    .insert(emailMessages)
    .values({
      accountId,
      providerMessageId: raw.providerMessageId,
      rfcMessageId: raw.rfcMessageId,
      threadId,
      direction: raw.direction,
      fromAddr: raw.from,
      toAddrs: raw.to,
      cc: raw.cc,
      subject: raw.subject,
      snippet: raw.snippet,
      bodyRef: null,
      sentAt: raw.sentAt,
      inReplyTo: raw.inReplyTo ?? null,
      refs: raw.references,
    })
    .onConflictDoNothing()
    .returning({ id: emailMessages.id });

  const inserted = insertedRows.length > 0;
  if (inserted) {
    const hook = deps.onMessagePersisted ?? NOOP_HOOK;
    await hook(exec, { accountId, raw, threadId, leadId });
  }
  return { inserted, threadId };
}

/** Whether a message already exists for this account (dedupe probe). */
export async function messageExists(
  exec: Db,
  accountId: string,
  rfcMessageId: string,
): Promise<boolean> {
  const rows = await exec
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(and(eq(emailMessages.accountId, accountId), eq(emailMessages.rfcMessageId, rfcMessageId)))
    .limit(1);
  return rows.length > 0;
}
