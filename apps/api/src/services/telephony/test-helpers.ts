import { asc, eq, sql } from 'drizzle-orm';
import {
  activities,
  calls,
  contacts,
  leads,
  notes,
  orgSettings,
  smsMessages,
  suppressions,
  users,
  type Db,
} from '../../db/index.ts';

/**
 * Seed + inspection helpers for the telephony (3b) suites — NOT a test file. Plain
 * inserts + read-backs; the ingress/dial paths under test drive the real
 * ActivityWriter and calls/sms rows.
 */

let telUserSeq = 0;

export async function seedUser(
  db: Db,
  opts: { name?: string; isActive?: boolean; role?: 'rep' | 'admin' } = {},
): Promise<string> {
  telUserSeq += 1;
  const email = `tel-user-${telUserSeq}@example.com`;
  const rows = await db
    .insert(users)
    .values({
      email,
      name: opts.name ?? `User ${telUserSeq}`,
      role: opts.role ?? 'rep',
      idpSubject: `idp|${email}`,
      isActive: opts.isActive ?? true,
    })
    .returning({ id: users.id });
  return rows[0]!.id;
}

export async function seedLead(
  db: Db,
  opts: { name?: string; ownerId?: string; dnc?: boolean } = {},
): Promise<string> {
  const rows = await db
    .insert(leads)
    .values({
      name: opts.name ?? 'Acme',
      ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
      ...(opts.dnc !== undefined ? { dnc: opts.dnc } : {}),
    })
    .returning({ id: leads.id });
  return rows[0]!.id;
}

export async function seedContact(
  db: Db,
  leadId: string,
  phones: string[],
  opts: { name?: string; dnc?: boolean } = {},
): Promise<string> {
  const rows = await db
    .insert(contacts)
    .values({
      leadId,
      name: opts.name ?? 'Contact',
      phones: phones.map((phone) => ({ phone, type: 'work' })),
      ...(opts.dnc !== undefined ? { dnc: opts.dnc } : {}),
    })
    .returning({ id: contacts.id });
  return rows[0]!.id;
}

export async function seedOrgSettings(
  db: Db,
  opts: { recordingEnabled?: boolean; companyTimezone?: string } = {},
): Promise<void> {
  await db.insert(orgSettings).values({
    recordingEnabled: opts.recordingEnabled ?? false,
    companyTimezone: opts.companyTimezone ?? 'UTC',
  });
}

// --- Inspection ------------------------------------------------------------

export interface ActivityRowLite {
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export async function activitiesFor(db: Db, leadId: string): Promise<ActivityRowLite[]> {
  const rows = await db
    .select({
      type: activities.type,
      occurredAt: activities.occurredAt,
      payload: activities.payload,
    })
    .from(activities)
    .where(eq(activities.leadId, leadId))
    .orderBy(asc(activities.occurredAt), asc(activities.type), asc(activities.id));
  return rows.map((r) => ({
    type: r.type,
    occurredAt: r.occurredAt,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

export interface CallRowSnapshot {
  id: string;
  direction: string;
  twilioSid: string | null;
  status: string;
  durationS: number | null;
  outcome: string | null;
  recordingRef: string | null;
  userId: string | null;
}

export async function callsFor(db: Db, leadId: string): Promise<CallRowSnapshot[]> {
  const rows = await db
    .select({
      id: calls.id,
      direction: calls.direction,
      twilioSid: calls.twilioSid,
      status: calls.status,
      durationS: calls.durationS,
      outcome: calls.outcome,
      recordingRef: calls.recordingRef,
      userId: calls.userId,
    })
    .from(calls)
    .where(eq(calls.leadId, leadId))
    .orderBy(asc(calls.createdAt), asc(calls.id));
  return rows;
}

export async function smsFor(
  db: Db,
  leadId: string,
): Promise<{ direction: string; body: string; providerSid: string | null; status: string }[]> {
  return db
    .select({
      direction: smsMessages.direction,
      body: smsMessages.body,
      providerSid: smsMessages.providerSid,
      status: smsMessages.status,
    })
    .from(smsMessages)
    .where(eq(smsMessages.leadId, leadId))
    .orderBy(asc(smsMessages.createdAt), asc(smsMessages.id));
}

export async function notesFor(
  db: Db,
  leadId: string,
): Promise<{ bodyMd: string; status: string; aiGenerated: boolean }[]> {
  return db
    .select({ bodyMd: notes.bodyMd, status: notes.status, aiGenerated: notes.aiGenerated })
    .from(notes)
    .where(eq(notes.leadId, leadId))
    .orderBy(asc(notes.createdAt), asc(notes.id));
}

export async function activePhoneSuppressions(db: Db): Promise<string[]> {
  const rows = await db
    .select({ value: suppressions.value })
    .from(suppressions)
    .where(sql`${suppressions.kind} = 'phone' AND ${suppressions.releasedAt} IS NULL`)
    .orderBy(asc(suppressions.value));
  return rows.map((r) => r.value);
}
