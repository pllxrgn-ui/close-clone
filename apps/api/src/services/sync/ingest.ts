import { and, eq } from 'drizzle-orm';
import type { RawEmail } from '@switchboard/shared/providers';
import { emailMessages, type Db } from '../../db/index.ts';
import { materializeThreadActivities } from '../email/activities.ts';
import { refreshThreadMatch } from '../email/matching.ts';
import {
  normalizeSubject,
  resolveThreadForMessage,
  threadParticipants,
} from '../email/threading.ts';
import type { LeadMatcher } from './matcher.ts';

/**
 * Idempotent persistence of one fetched message into `email_messages` +
 * `email_threads` — the shared write used by both backfill and incremental pull
 * (CONTRACTS §C5 I-SYNC). It is 2c's threading/matching seam: a first-sighting
 * insert is threaded (RFC 5322 / subject fallback, `services/email/threading.ts`),
 * matched to a lead if the participants resolve to exactly one
 * (`services/email/matching.ts`), and — when matched — turned into
 * `email_received`/`email_sent` activities (`services/email/activities.ts`).
 *
 * The message is inserted FIRST with a null `thread_id` so novelty is decided by
 * the unique index (`account_id, rfc_message_id` — the dedupe backstop — and
 * `account_id, provider_message_id`). Every threading/matching/activity side
 * effect runs ONLY on a first sighting, so a replayed or reordered message is a
 * pure no-op (I-SYNC). All work runs on the caller's transaction handle (`exec`)
 * so it commits atomically with the cursor/checkpoint advance.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface IngestDeps {
  /** Thread → lead matcher (default `AmbiguousLeadMatcher`; production wires the real one). */
  matcher: LeadMatcher;
}

export interface IngestResult {
  /** True iff this call inserted a new `email_messages` row (first sighting). */
  inserted: boolean;
  /** The message's thread (null only if a duplicate had no resolvable thread). */
  threadId: string | null;
}

// Re-exported for the sync barrel; canonical implementations live in threading.ts.
export { normalizeSubject, threadParticipants };

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
  const insertedRows = await exec
    .insert(emailMessages)
    .values({
      accountId,
      providerMessageId: raw.providerMessageId,
      rfcMessageId: raw.rfcMessageId,
      threadId: null,
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

  const insertedRow = insertedRows[0];
  if (insertedRow === undefined) {
    // Duplicate (any interleaving/replay): no threading, matching, or activity.
    const existing = await exec
      .select({ threadId: emailMessages.threadId })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.accountId, accountId),
          eq(emailMessages.rfcMessageId, raw.rfcMessageId),
        ),
      )
      .limit(1);
    return { inserted: false, threadId: existing[0]?.threadId ?? null };
  }

  const messageId = insertedRow.id;
  const threadId = await resolveThreadForMessage(exec, accountId, messageId, raw);
  const decision = await refreshThreadMatch(exec, deps.matcher, accountId, threadId);
  // A matched thread materializes its messages' activities exactly once; this both
  // emits the just-inserted message's activity and backfills any prior messages
  // that were ambiguous at their own ingest and are now covered by a lead.
  if (decision.leadId !== null) {
    await materializeThreadActivities(exec, threadId, decision.leadId);
  }
  return { inserted: true, threadId };
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
