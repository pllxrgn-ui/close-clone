import { and, eq, sql } from 'drizzle-orm';
import { auditLog, emailThreads, leads, users, type Db } from '../../db/index.ts';
import { materializeThreadActivities } from './activities.ts';
import { findCandidateLeadIds } from './matching.ts';

/**
 * Ambiguity triage queue (task 2c, CONTRACTS §C1/§C4/§C5).
 *
 * A thread whose participants resolve to zero or many leads is `ambiguous` and
 * queued here for a human (never guessed — CONTRACTS §C5). `resolveThreadToLead`
 * attaches the chosen lead and materializes the thread's messages as timeline
 * activities exactly once (through the same `materializeThreadActivities` path
 * ingest uses, so the C4 denorm columns advance and no message double-writes);
 * `ignoreThread` marks the thread not-a-lead. Both are auditable (actor + time in
 * `audit_log`) and RBAC-safe: a mutation requires a valid, ACTIVE user as actor —
 * there is no anonymous resolve/ignore path. Reads (the queue) follow the app's
 * current open-read posture.
 *
 * Idempotency (CONTRACTS §C4/§C5): resolving a thread already matched to the SAME
 * lead is a no-op; ignoring an already-ignored thread is a no-op. Re-pointing a
 * matched thread to a DIFFERENT lead is refused (`TriageConflictError`) rather
 * than stranding the append-only activities already written to the first lead —
 * a correction/merge flow is out of 2c scope.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

// --- Errors ----------------------------------------------------------------

export class TriageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriageError';
  }
}

/** The thread id does not exist. */
export class ThreadNotFoundError extends TriageError {
  readonly threadId: string;
  constructor(threadId: string) {
    super(`email thread ${threadId} not found`);
    this.name = 'ThreadNotFoundError';
    this.threadId = threadId;
  }
}

/** The target lead does not exist or is soft-deleted. */
export class TriageLeadNotFoundError extends TriageError {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`lead ${leadId} not found or soft-deleted`);
    this.name = 'TriageLeadNotFoundError';
    this.leadId = leadId;
  }
}

/** The thread is in a state the requested action cannot apply to. */
export class TriageConflictError extends TriageError {
  constructor(message: string) {
    super(message);
    this.name = 'TriageConflictError';
  }
}

/** The actor is missing, unknown, or not an active user (RBAC-safe default). */
export class ActorNotAllowedError extends TriageError {
  readonly actorId: string;
  constructor(actorId: string) {
    super(`actor ${actorId} is not a permitted, active user`);
    this.name = 'ActorNotAllowedError';
    this.actorId = actorId;
  }
}

/** The supplied pagination cursor is malformed. */
export class InvalidTriageCursorError extends TriageError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTriageCursorError';
  }
}

// --- Cursor (keyset over created_at, id) -----------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    throw new InvalidTriageCursorError(`bad triage cursor ${cursor}`);
  }
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) throw new InvalidTriageCursorError(`bad triage cursor ${cursor}`);
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!UUID_RE.test(id) || Number.isNaN(Date.parse(createdAt))) {
    throw new InvalidTriageCursorError(`bad triage cursor ${cursor}`);
  }
  return { createdAt, id };
}

// --- Actor / lead guards ---------------------------------------------------

async function assertActiveActor(exec: Db, actorId: string): Promise<void> {
  if (!UUID_RE.test(actorId)) throw new ActorNotAllowedError(actorId);
  const rows = await exec
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actorId), eq(users.isActive, true)))
    .limit(1);
  if (rows[0] === undefined) throw new ActorNotAllowedError(actorId);
}

async function leadExists(exec: Db, leadId: string): Promise<boolean> {
  const rows = await exec
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, leadId), sql`${leads.deletedAt} is null`))
    .limit(1);
  return rows[0] !== undefined;
}

interface ThreadRow {
  id: string;
  triageStatus: 'matched' | 'ambiguous' | 'ignored';
  leadId: string | null;
}

async function loadThread(exec: Db, threadId: string): Promise<ThreadRow> {
  if (!UUID_RE.test(threadId)) throw new ThreadNotFoundError(threadId);
  const rows = await exec
    .select({
      id: emailThreads.id,
      triageStatus: emailThreads.triageStatus,
      leadId: emailThreads.leadId,
    })
    .from(emailThreads)
    .where(eq(emailThreads.id, threadId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new ThreadNotFoundError(threadId);
  return row;
}

async function writeAudit(
  exec: Db,
  input: {
    actorId: string;
    action: string;
    threadId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    reason?: string | undefined;
  },
): Promise<void> {
  await exec.insert(auditLog).values({
    actorId: input.actorId,
    actorType: 'user',
    action: input.action,
    entity: 'email_thread',
    entityId: input.threadId,
    before: input.before,
    after: input.after,
    reason: input.reason ?? null,
  });
}

// --- List (the queue) ------------------------------------------------------

export interface AmbiguousThreadSummary {
  threadId: string;
  subjectNorm: string | null;
  participants: string[];
  messageCount: number;
  /** Distinct candidate leads for the current participants (0 or ≥2 ⇒ ambiguous). */
  candidateLeadIds: string[];
  createdAt: string;
}

export interface TriageListOptions {
  limit?: number;
  cursor?: string;
}

export interface TriageListResult {
  items: AmbiguousThreadSummary[];
  nextCursor?: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Page the ambiguous-thread queue oldest-first, keyset over `(created_at, id)`.
 * Each row carries its message count and the current candidate lead set (computed
 * with the same participant→contact matcher) so the human sees why it is
 * ambiguous. `nextCursor` is present iff another page exists.
 */
export async function listAmbiguousThreads(
  db: Db,
  options: TriageListOptions = {},
): Promise<TriageListResult> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const after = options.cursor === undefined ? null : decodeCursor(options.cursor);

  const keyset =
    after === null
      ? sql``
      : sql`AND (t.created_at, t.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`;

  const result = await db.execute(sql`
    SELECT
      t.id AS id,
      t.subject_norm AS subject_norm,
      t.participants AS participants,
      t.created_at AS created_at,
      (SELECT count(*)::int FROM email_messages m WHERE m.thread_id = t.id) AS message_count,
      (SELECT m.account_id FROM email_messages m WHERE m.thread_id = t.id
         ORDER BY m.created_at ASC, m.id ASC LIMIT 1) AS account_id
    FROM email_threads t
    WHERE t.triage_status = 'ambiguous'
    ${keyset}
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT ${limit + 1}
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;

  const page = rows.slice(0, limit);
  const items: AmbiguousThreadSummary[] = [];
  for (const row of page) {
    const participants = (row['participants'] as unknown[]).map((p) => String(p));
    const accountId = row['account_id'] === null ? null : String(row['account_id']);
    const candidateLeadIds =
      accountId === null ? [] : await findCandidateLeadIds(db, accountId, participants);
    items.push({
      threadId: String(row['id']),
      subjectNorm: row['subject_norm'] === null ? null : String(row['subject_norm']),
      participants,
      messageCount: Number(row['message_count']),
      candidateLeadIds,
      createdAt: String(row['created_at']),
    });
  }

  if (rows.length > limit) {
    const last = page[page.length - 1]!;
    return { items, nextCursor: encodeCursor(String(last['created_at']), String(last['id'])) };
  }
  return { items };
}

// --- Resolve (attach a lead) -----------------------------------------------

export interface ResolveInput {
  threadId: string;
  leadId: string;
  /** The user performing the resolution (audit "who"; must be active). */
  actorId: string;
  reason?: string;
}

export interface ResolveResult {
  threadId: string;
  leadId: string;
  triageStatus: 'matched';
  /** Activities newly written by this call (0 on an idempotent re-resolve). */
  activitiesWritten: number;
  /** True iff the thread was already matched to this same lead (no change). */
  alreadyResolved: boolean;
}

/**
 * Attach `leadId` to `threadId` (human triage decision) and materialize the
 * thread's messages as `email_received`/`email_sent` activities on that lead.
 * Refuses to re-point a thread already matched to a different lead. Idempotent
 * for a re-resolve to the same lead. Everything commits in one transaction.
 */
export async function resolveThreadToLead(db: Db, input: ResolveInput): Promise<ResolveResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    await assertActiveActor(tx, input.actorId);

    const thread = await loadThread(tx, input.threadId);

    if (thread.triageStatus === 'matched') {
      if (thread.leadId === input.leadId) {
        // Idempotent: ensure activities exist (they will), change nothing else.
        const written = await materializeThreadActivities(tx, input.threadId, input.leadId);
        return {
          threadId: input.threadId,
          leadId: input.leadId,
          triageStatus: 'matched',
          activitiesWritten: written,
          alreadyResolved: true,
        };
      }
      throw new TriageConflictError(
        `thread ${input.threadId} is already matched to lead ${thread.leadId}; re-pointing is not a triage action`,
      );
    }

    if (!(await leadExists(tx, input.leadId))) {
      throw new TriageLeadNotFoundError(input.leadId);
    }

    await tx
      .update(emailThreads)
      .set({ triageStatus: 'matched', leadId: input.leadId, updatedAt: sql`now()` })
      .where(eq(emailThreads.id, input.threadId));

    const written = await materializeThreadActivities(tx, input.threadId, input.leadId);

    await writeAudit(tx, {
      actorId: input.actorId,
      action: 'email_thread.resolved',
      threadId: input.threadId,
      before: { triageStatus: thread.triageStatus, leadId: thread.leadId },
      after: { triageStatus: 'matched', leadId: input.leadId },
      reason: input.reason,
    });

    return {
      threadId: input.threadId,
      leadId: input.leadId,
      triageStatus: 'matched',
      activitiesWritten: written,
      alreadyResolved: false,
    };
  });
}

// --- Ignore (not a lead) ---------------------------------------------------

export interface IgnoreInput {
  threadId: string;
  actorId: string;
  reason?: string;
}

export interface IgnoreResult {
  threadId: string;
  triageStatus: 'ignored';
  /** True iff the thread was already ignored (no change). */
  alreadyIgnored: boolean;
}

/**
 * Mark an ambiguous thread as not-a-lead. Idempotent for an already-ignored
 * thread. Refuses to ignore a thread already matched to a lead (it is no longer a
 * triage-queue item and has activities on that lead).
 */
export async function ignoreThread(db: Db, input: IgnoreInput): Promise<IgnoreResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    await assertActiveActor(tx, input.actorId);

    const thread = await loadThread(tx, input.threadId);

    if (thread.triageStatus === 'ignored') {
      return { threadId: input.threadId, triageStatus: 'ignored', alreadyIgnored: true };
    }
    if (thread.triageStatus === 'matched') {
      throw new TriageConflictError(
        `thread ${input.threadId} is matched to lead ${thread.leadId}; ignore a matched thread is not a triage action`,
      );
    }

    await tx
      .update(emailThreads)
      .set({ triageStatus: 'ignored', updatedAt: sql`now()` })
      .where(eq(emailThreads.id, input.threadId));

    await writeAudit(tx, {
      actorId: input.actorId,
      action: 'email_thread.ignored',
      threadId: input.threadId,
      before: { triageStatus: thread.triageStatus, leadId: thread.leadId },
      after: { triageStatus: 'ignored', leadId: null },
      reason: input.reason,
    });

    return { threadId: input.threadId, triageStatus: 'ignored', alreadyIgnored: false };
  });
}
