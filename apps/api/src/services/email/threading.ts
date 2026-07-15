import { eq, sql } from 'drizzle-orm';
import type { RawEmail } from '@switchboard/shared/providers';
import { emailMessages, emailThreads, type Db } from '../../db/index.ts';

/**
 * Email threading (task 2c, CONTRACTS §C1 email_threads/email_messages).
 *
 * A newly-persisted message is grouped into a thread by, in order:
 *   1. RFC 5322 linkage — its {Message-ID, In-Reply-To, References} share an id
 *      with an existing message's id-set. This is symmetric, so a reply that
 *      arrives BEFORE its parent still joins once the parent lands (the parent's
 *      Message-ID is in the reply's References). If a message bridges two hitherto
 *      separate threads, they MERGE into one.
 *   2. Fallback — same normalized subject AND identical participant set.
 *   3. Otherwise a fresh thread.
 *
 * Threading is deterministic: the final grouping (and every dumped thread column)
 * is a pure function of the message set, independent of arrival order. Thread
 * attributes are recomputed from members on every change; the provider thread id
 * is folded as a running `LEAST` so it is order-independent even when the fallback
 * groups messages the provider had split. Threading is account-scoped in practice
 * (linkage/fallback only reach threads that already hold one of the account's
 * messages), matching the per-account dedupe key (CONTRACTS §C1).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** Strip leading Re:/Fwd:/Fw: prefixes, trim, lowercase — the thread group key. */
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? '')
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

/** Deduped, sorted participant addresses from a message's from/to/cc. */
export function participantsOf(
  from: string | null | undefined,
  to: readonly unknown[],
  cc: readonly unknown[],
): string[] {
  const all = [from, ...to, ...cc]
    .map((a) => (a === null || a === undefined ? '' : String(a)))
    .filter((a) => a.length > 0);
  return [...new Set(all)].sort();
}

/** Participant set for a fetched message (from + to + cc). */
export function threadParticipants(raw: RawEmail): string[] {
  return participantsOf(raw.from, raw.to, raw.cc);
}

/** The message's own id + everything it references (dedupe key set for linkage). */
export function computeIdSet(raw: RawEmail): string[] {
  const ids = [raw.rfcMessageId, raw.inReplyTo ?? '', ...raw.references]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0);
  return [...new Set(ids)];
}

/** Case-insensitive, order-independent participant-set equality. */
function sameParticipantSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (xs: readonly string[]): string[] => [...xs].map((x) => x.toLowerCase()).sort();
  const na = norm(a);
  const nb = norm(b);
  return na.every((v, i) => v === nb[i]);
}

/** Build a `text[]` SQL literal from string params (safe: each is bound). */
function textArray(values: string[]): ReturnType<typeof sql> {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Distinct threads (of THIS account's messages) that share any id with `idSet`,
 * excluding the message being threaded. Empty `idSet` ⇒ no linkage.
 */
async function findLinkedThreadIds(
  exec: Db,
  accountId: string,
  excludeMessageId: string,
  idSet: string[],
): Promise<string[]> {
  if (idSet.length === 0) return [];
  const arr = textArray(idSet);
  const result = await exec.execute(sql`
    SELECT DISTINCT m.thread_id AS thread_id
    FROM email_messages m
    WHERE m.account_id = ${accountId}
      AND m.id <> ${excludeMessageId}
      AND m.thread_id IS NOT NULL
      AND (
           m.rfc_message_id = ANY(${arr})
        OR m.in_reply_to = ANY(${arr})
        OR m.refs ?| ${arr}
      )
    ORDER BY m.thread_id ASC
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  return rows.map((r) => String(r['thread_id']));
}

/**
 * A fallback thread for `(subjectNorm, participants)`: an existing thread of one
 * of THIS account's messages with the same normalized subject and an identical
 * participant set. Returns the thread id or null. Participant comparison is done
 * in-app (case-insensitive) so it does not depend on jsonb ordering.
 */
async function findFallbackThreadId(
  exec: Db,
  accountId: string,
  subjectNorm: string,
  participants: string[],
): Promise<string | null> {
  const result = await exec.execute(sql`
    SELECT DISTINCT t.id AS id, t.participants AS participants
    FROM email_threads t
    JOIN email_messages m ON m.thread_id = t.id AND m.account_id = ${accountId}
    WHERE coalesce(t.subject_norm, '') = ${subjectNorm}
    ORDER BY t.id ASC
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  for (const row of rows) {
    const parts = (row['participants'] as unknown[]).map((p) => String(p));
    if (sameParticipantSet(parts, participants)) return String(row['id']);
  }
  return null;
}

/** Insert an empty thread (attributes filled by {@link recomputeThreadAttributes}). */
async function createEmptyThread(exec: Db): Promise<string> {
  const inserted = await exec
    .insert(emailThreads)
    .values({ triageStatus: 'ambiguous' })
    .returning({ id: emailThreads.id });
  const row = inserted[0];
  if (row === undefined) throw new Error('threading: thread insert returned no row');
  return row.id;
}

/**
 * Merge `threadIds` (≥1) into one survivor and return it. Message rows move to the
 * survivor; the other thread rows are deleted. The survivor inherits, by
 * precedence, the strongest triage decision among members so no matched lead or
 * human "ignore" is lost to a merge: matched (min lead id) > ignored > ambiguous.
 * The surviving provider thread id is the min across members. All of these are
 * pure functions of the member set, so a merge is order-independent.
 */
async function mergeThreads(exec: Db, threadIds: string[]): Promise<string> {
  const distinct = [...new Set(threadIds)].sort();
  const survivor = distinct[0]!;
  if (distinct.length === 1) return survivor;

  const rows = await exec
    .select({
      id: emailThreads.id,
      triageStatus: emailThreads.triageStatus,
      leadId: emailThreads.leadId,
      providerThreadId: emailThreads.providerThreadId,
    })
    .from(emailThreads)
    .where(sql`${emailThreads.id} = ANY(${textArray(distinct)}::uuid[])`);

  const matchedLeadIds = rows
    .filter((r) => r.triageStatus === 'matched' && r.leadId !== null)
    .map((r) => r.leadId!)
    .sort();
  const anyIgnored = rows.some((r) => r.triageStatus === 'ignored');
  const providerIds = rows
    .map((r) => r.providerThreadId)
    .filter((p): p is string => p !== null && p.length > 0)
    .sort();

  let triageStatus: 'matched' | 'ignored' | 'ambiguous' = 'ambiguous';
  let leadId: string | null = null;
  if (matchedLeadIds.length > 0) {
    triageStatus = 'matched';
    leadId = matchedLeadIds[0]!;
  } else if (anyIgnored) {
    triageStatus = 'ignored';
  }

  for (const other of distinct.slice(1)) {
    await exec
      .update(emailMessages)
      .set({ threadId: survivor, updatedAt: sql`now()` })
      .where(eq(emailMessages.threadId, other));
    await exec.delete(emailThreads).where(eq(emailThreads.id, other));
  }

  await exec
    .update(emailThreads)
    .set({
      triageStatus,
      leadId,
      providerThreadId: providerIds[0] ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(emailThreads.id, survivor));

  return survivor;
}

/**
 * Recompute a thread's derived attributes from its current members:
 *   - subject_norm = normalized subject of the ROOT (earliest sent_at, then
 *     smallest rfc_message_id) message;
 *   - participants = sorted union of every member's from/to/cc;
 *   - provider_thread_id = running `LEAST` with the incoming message's thread id.
 * All are order-independent functions of the member set.
 */
async function recomputeThreadAttributes(
  exec: Db,
  threadId: string,
  incomingProviderThreadId: string | null | undefined,
): Promise<void> {
  const msgs = await exec
    .select({
      fromAddr: emailMessages.fromAddr,
      toAddrs: emailMessages.toAddrs,
      cc: emailMessages.cc,
      subject: emailMessages.subject,
      sentAt: emailMessages.sentAt,
      rfcMessageId: emailMessages.rfcMessageId,
    })
    .from(emailMessages)
    .where(eq(emailMessages.threadId, threadId));

  const union = new Set<string>();
  for (const m of msgs) {
    for (const p of participantsOf(m.fromAddr, m.toAddrs, m.cc)) union.add(p);
  }
  const participants = [...union].sort();

  const root = [...msgs].sort((a, b) => {
    const sa = a.sentAt ?? '';
    const sb = b.sentAt ?? '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    const ra = a.rfcMessageId ?? '';
    const rb = b.rfcMessageId ?? '';
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  })[0];
  const subjectNorm = normalizeSubject(root?.subject ?? '');

  const incoming =
    incomingProviderThreadId !== null &&
    incomingProviderThreadId !== undefined &&
    incomingProviderThreadId.length > 0
      ? incomingProviderThreadId
      : null;

  await exec
    .update(emailThreads)
    .set({
      subjectNorm,
      participants,
      providerThreadId: sql`least(${emailThreads.providerThreadId}, ${incoming})`,
      updatedAt: sql`now()`,
    })
    .where(eq(emailThreads.id, threadId));
}

/**
 * Resolve (and, if needed, create/merge) the thread for an already-inserted
 * message `messageId` whose fetched form is `raw`. Assigns the message to the
 * thread and recomputes the thread's attributes. Returns the thread id.
 */
export async function resolveThreadForMessage(
  exec: Db,
  accountId: string,
  messageId: string,
  raw: RawEmail,
): Promise<string> {
  const idSet = computeIdSet(raw);
  const linked = await findLinkedThreadIds(exec, accountId, messageId, idSet);

  let threadId: string;
  if (linked.length > 0) {
    threadId = await mergeThreads(exec, linked);
  } else {
    const subjectNorm = normalizeSubject(raw.subject);
    const participants = threadParticipants(raw);
    const fallback = await findFallbackThreadId(exec, accountId, subjectNorm, participants);
    threadId = fallback ?? (await createEmptyThread(exec));
  }

  await exec
    .update(emailMessages)
    .set({ threadId, updatedAt: sql`now()` })
    .where(eq(emailMessages.id, messageId));

  await recomputeThreadAttributes(exec, threadId, raw.threadId);
  return threadId;
}
