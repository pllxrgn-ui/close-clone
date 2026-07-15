import { asc, eq, sql } from 'drizzle-orm';
import { emailMessages, emailThreads, type Db } from '../../db/index.ts';
import { ThreadNotFoundError } from './triage.ts';

/**
 * Email thread READ surface (task 2d, CONTRACTS §C7 `emails` — threads read).
 *
 * Backs the lead page's conversation view and the reply-from-CRM flow: the client
 * lists a lead's threads, opens one to see its messages, and picks the message id
 * to reply to (fed to `sendOneOff({ inReplyToMessageId })`). Read-only — no rails
 * here; the send path owns compliance.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export class InvalidThreadCursorError extends Error {
  constructor(cursor: string) {
    super(`bad thread cursor ${cursor}`);
    this.name = 'InvalidThreadCursorError';
  }
}

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidThreadCursorError(cursor);
  }
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) throw new InvalidThreadCursorError(cursor);
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!UUID_RE.test(id) || Number.isNaN(Date.parse(createdAt)))
    throw new InvalidThreadCursorError(cursor);
  return { createdAt, id };
}

export interface ThreadSummary {
  threadId: string;
  leadId: string | null;
  subjectNorm: string | null;
  participants: string[];
  triageStatus: string;
  providerThreadId: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ListThreadsOptions {
  leadId?: string;
  limit?: number;
  cursor?: string;
}

export interface ListThreadsResult {
  items: ThreadSummary[];
  nextCursor?: string;
}

/** Page threads (optionally scoped to a lead), keyset over (created_at, id) asc. */
export async function listThreads(
  db: Db,
  options: ListThreadsOptions = {},
): Promise<ListThreadsResult> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  // Raw fragments use the `t` alias so a filtered query stays consistent with the
  // aliased FROM (a drizzle-rendered column would emit the un-aliased table name).
  const clauses: ReturnType<typeof sql>[] = [];
  if (options.leadId !== undefined) clauses.push(sql`t.lead_id = ${options.leadId}::uuid`);
  if (options.cursor !== undefined) {
    const after = decodeCursor(options.cursor);
    clauses.push(sql`(t.created_at, t.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
  }
  const whereSql = clauses.length > 0 ? sql`WHERE ${sql.join(clauses, sql` AND `)}` : sql``;

  const result = await db.execute(sql`
    SELECT
      t.id AS id,
      t.lead_id AS lead_id,
      t.subject_norm AS subject_norm,
      t.participants AS participants,
      t.triage_status AS triage_status,
      t.provider_thread_id AS provider_thread_id,
      t.created_at AS created_at,
      (SELECT count(*)::int FROM email_messages m WHERE m.thread_id = t.id) AS message_count,
      (SELECT max(m.sent_at) FROM email_messages m WHERE m.thread_id = t.id) AS last_message_at
    FROM email_threads t
    ${whereSql}
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT ${limit + 1}
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  const page = rows.slice(0, limit);
  const items: ThreadSummary[] = page.map((r) => ({
    threadId: String(r['id']),
    leadId: r['lead_id'] === null ? null : String(r['lead_id']),
    subjectNorm: r['subject_norm'] === null ? null : String(r['subject_norm']),
    participants: (r['participants'] as unknown[]).map((p) => String(p)),
    triageStatus: String(r['triage_status']),
    providerThreadId: r['provider_thread_id'] === null ? null : String(r['provider_thread_id']),
    messageCount: Number(r['message_count']),
    lastMessageAt: r['last_message_at'] === null ? null : String(r['last_message_at']),
    createdAt: String(r['created_at']),
  }));

  if (rows.length > limit) {
    const last = page[page.length - 1]!;
    return { items, nextCursor: encodeCursor(String(last['created_at']), String(last['id'])) };
  }
  return { items };
}

export interface ThreadMessage {
  id: string;
  direction: string;
  fromAddr: string | null;
  toAddrs: string[];
  cc: string[];
  subject: string | null;
  snippet: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  sentAt: string | null;
}

export interface ThreadDetail extends ThreadSummary {
  messages: ThreadMessage[];
}

/** A thread with its messages (oldest first) — the conversation view. */
export async function getThread(db: Db, threadId: string): Promise<ThreadDetail> {
  if (!UUID_RE.test(threadId)) throw new ThreadNotFoundError(threadId);
  const rows = await db
    .select({
      id: emailThreads.id,
      leadId: emailThreads.leadId,
      subjectNorm: emailThreads.subjectNorm,
      participants: emailThreads.participants,
      triageStatus: emailThreads.triageStatus,
      providerThreadId: emailThreads.providerThreadId,
      createdAt: emailThreads.createdAt,
    })
    .from(emailThreads)
    .where(eq(emailThreads.id, threadId))
    .limit(1);
  const thread = rows[0];
  if (thread === undefined) throw new ThreadNotFoundError(threadId);

  const msgs = await db
    .select({
      id: emailMessages.id,
      direction: emailMessages.direction,
      fromAddr: emailMessages.fromAddr,
      toAddrs: emailMessages.toAddrs,
      cc: emailMessages.cc,
      subject: emailMessages.subject,
      snippet: emailMessages.snippet,
      rfcMessageId: emailMessages.rfcMessageId,
      inReplyTo: emailMessages.inReplyTo,
      sentAt: emailMessages.sentAt,
    })
    .from(emailMessages)
    .where(eq(emailMessages.threadId, threadId))
    .orderBy(asc(emailMessages.sentAt), asc(emailMessages.rfcMessageId));

  const messages: ThreadMessage[] = msgs.map((m) => ({
    id: m.id,
    direction: m.direction,
    fromAddr: m.fromAddr,
    toAddrs: (m.toAddrs as unknown[]).map((a) => String(a)),
    cc: (m.cc as unknown[]).map((a) => String(a)),
    subject: m.subject,
    snippet: m.snippet,
    rfcMessageId: m.rfcMessageId,
    inReplyTo: m.inReplyTo,
    sentAt: m.sentAt,
  }));

  let lastMessageAt: string | null = null;
  for (const m of messages) {
    if (m.sentAt !== null && (lastMessageAt === null || m.sentAt > lastMessageAt))
      lastMessageAt = m.sentAt;
  }

  return {
    threadId: thread.id,
    leadId: thread.leadId,
    subjectNorm: thread.subjectNorm,
    participants: (thread.participants as unknown[]).map((p) => String(p)),
    triageStatus: thread.triageStatus,
    providerThreadId: thread.providerThreadId,
    messageCount: messages.length,
    lastMessageAt,
    createdAt: thread.createdAt,
    messages,
  };
}
