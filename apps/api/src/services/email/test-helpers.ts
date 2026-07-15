import { and, asc, eq, sql } from 'drizzle-orm';
import type { RawEmail } from '@switchboard/shared/providers';
import {
  activities,
  auditLog,
  contacts,
  emailAccounts,
  leads,
  users,
  type Db,
} from '../../db/index.ts';
import { ingestMessage, type IngestDeps } from '../sync/ingest.ts';

/**
 * Seed + drive helpers for the email (2c) suites — NOT a test file. Everything
 * seeds through plain inserts and drives message ingest through the real
 * `ingestMessage` seam (wrapped in a transaction, exactly as backfill/pull do), so
 * the tests exercise the production threading/matching/activity path.
 */

let userSeq = 0;

export async function seedUser(
  db: Db,
  opts: { email?: string; isActive?: boolean; role?: 'rep' | 'admin' } = {},
): Promise<string> {
  userSeq += 1;
  const email = opts.email ?? `rep${userSeq}@example.com`;
  const rows = await db
    .insert(users)
    .values({
      email,
      name: 'Rep',
      role: opts.role ?? 'rep',
      idpSubject: `idp|${email}`,
      isActive: opts.isActive ?? true,
    })
    .returning({ id: users.id });
  return rows[0]!.id;
}

export async function seedLead(db: Db, name = 'Acme'): Promise<string> {
  const rows = await db.insert(leads).values({ name }).returning({ id: leads.id });
  return rows[0]!.id;
}

export async function softDeleteLead(db: Db, leadId: string): Promise<void> {
  await db.update(leads).set({ deletedAt: sql`now()` }).where(eq(leads.id, leadId));
}

export async function seedContact(
  db: Db,
  leadId: string,
  emails: string[],
  opts: { deleted?: boolean; name?: string } = {},
): Promise<string> {
  const rows = await db
    .insert(contacts)
    .values({
      leadId,
      name: opts.name ?? 'Contact',
      emails: emails.map((email) => ({ email, type: 'work' })),
      ...(opts.deleted === true ? { deletedAt: sql`now()` } : {}),
    })
    .returning({ id: contacts.id });
  return rows[0]!.id;
}

export async function seedAccount(db: Db, userId: string, address = 'rep@mock.test'): Promise<string> {
  const rows = await db
    .insert(emailAccounts)
    .values({ userId, address, provider: 'mock', syncStatus: 'LIVE' })
    .returning({ id: emailAccounts.id });
  return rows[0]!.id;
}

let rawSeq = 0;

export interface RawOverrides {
  providerMessageId?: string;
  rfcMessageId?: string;
  threadId?: string;
  historyId?: string;
  direction?: 'in' | 'out';
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  inReplyTo?: string;
  references?: string[];
  sentAt?: string;
}

/** A RawEmail with deterministic defaults; override only what a test cares about. */
export function makeRaw(overrides: RawOverrides = {}): RawEmail {
  rawSeq += 1;
  const rfc = overrides.rfcMessageId ?? `<raw-${rawSeq}@ext.test>`;
  const base: RawEmail = {
    providerMessageId: overrides.providerMessageId ?? `msg-${rawSeq}`,
    rfcMessageId: rfc,
    threadId: overrides.threadId ?? `t-${rawSeq}`,
    historyId: overrides.historyId ?? String(rawSeq * 10),
    direction: overrides.direction ?? 'in',
    from: overrides.from ?? 'a@ext.test',
    to: overrides.to ?? ['rep@mock.test'],
    cc: overrides.cc ?? [],
    subject: overrides.subject ?? 'Hello',
    snippet: 'snippet',
    references: overrides.references ?? [],
    headers: {},
    labels: ['INBOX'],
    sentAt: overrides.sentAt ?? '2026-02-01T10:00:00.000Z',
    ...(overrides.inReplyTo !== undefined ? { inReplyTo: overrides.inReplyTo } : {}),
  };
  return base;
}

/** Drive one message through the real ingest seam inside a transaction. */
export async function ingest(
  db: Db,
  deps: IngestDeps,
  accountId: string,
  raw: RawEmail,
): Promise<{ inserted: boolean; threadId: string | null }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    return ingestMessage(tx, deps, accountId, raw);
  });
}

// --- Inspection ------------------------------------------------------------

export interface ThreadSnapshot {
  id: string;
  providerThreadId: string | null;
  subjectNorm: string | null;
  participants: string[];
  triageStatus: string;
  leadId: string | null;
  messageRfcIds: string[];
}

export async function threadsFor(db: Db, accountId: string): Promise<ThreadSnapshot[]> {
  const result = await db.execute(sql`
    SELECT t.id, t.provider_thread_id, t.subject_norm, t.participants, t.triage_status, t.lead_id,
      (SELECT coalesce(json_agg(m.rfc_message_id ORDER BY m.rfc_message_id), '[]'::json)
         FROM email_messages m WHERE m.thread_id = t.id) AS rfc_ids
    FROM email_threads t
    WHERE EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id AND m.account_id = ${accountId})
    ORDER BY t.provider_thread_id ASC, t.id ASC
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  return rows.map((r) => ({
    id: String(r['id']),
    providerThreadId: r['provider_thread_id'] === null ? null : String(r['provider_thread_id']),
    subjectNorm: r['subject_norm'] === null ? null : String(r['subject_norm']),
    participants: (r['participants'] as unknown[]).map((p) => String(p)),
    triageStatus: String(r['triage_status']),
    leadId: r['lead_id'] === null ? null : String(r['lead_id']),
    messageRfcIds: (r['rfc_ids'] as unknown[]).map((x) => String(x)),
  }));
}

export async function activitiesFor(db: Db, leadId: string): Promise<
  { type: string; occurredAt: string; emailMessageId: string | null }[]
> {
  const rows = await db
    .select({ type: activities.type, occurredAt: activities.occurredAt, payload: activities.payload })
    .from(activities)
    .where(eq(activities.leadId, leadId))
    .orderBy(asc(activities.occurredAt), asc(activities.type));
  return rows.map((r) => ({
    type: r.type,
    occurredAt: r.occurredAt,
    emailMessageId:
      r.payload !== null && typeof r.payload === 'object' && 'emailMessageId' in r.payload
        ? String((r.payload as Record<string, unknown>)['emailMessageId'])
        : null,
  }));
}

export async function leadTouch(
  db: Db,
  leadId: string,
): Promise<{ lastEmailAt: string | null; lastInboundAt: string | null; lastContactedAt: string | null }> {
  const rows = await db
    .select({
      lastEmailAt: leads.lastEmailAt,
      lastInboundAt: leads.lastInboundAt,
      lastContactedAt: leads.lastContactedAt,
    })
    .from(leads)
    .where(eq(leads.id, leadId));
  return rows[0]!;
}

export async function auditFor(
  db: Db,
  threadId: string,
): Promise<{ action: string; actorId: string | null; actorType: string; at: string }[]> {
  const rows = await db
    .select({
      action: auditLog.action,
      actorId: auditLog.actorId,
      actorType: auditLog.actorType,
      at: auditLog.at,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'email_thread'), eq(auditLog.entityId, threadId)))
    .orderBy(asc(auditLog.at));
  return rows;
}
