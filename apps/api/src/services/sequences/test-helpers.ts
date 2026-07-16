import { eq, sql } from 'drizzle-orm';
import {
  activities,
  contacts,
  emailAccounts,
  leads,
  orgSettings,
  sendIntents,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  templates,
  users,
  type Db,
} from '../../db/index.ts';
import { MockEmailProvider } from '../../providers/mock/mock-email-provider.ts';
import { TokenCipher } from '../sync/token-cipher.ts';
import { InProcessQueueDriver } from '../../queue/index.ts';
import type { DispatchDeps } from './dispatch.ts';
import type { UnsubscribeHeaderConfig } from './unsubscribe.ts';

/**
 * Seed + wiring helpers for the sequence-engine suites (task 2e). NOT a test file.
 * Builds a real PGlite-backed engine with per-mailbox MockEmailProviders and a
 * deterministic manual-tick queue driver + injected clock, so every never-event
 * test is fully reproducible.
 */

export const ENGINE_SECRET = 'sequence-engine-test-secret';

export const UNSUB_CONFIG: UnsubscribeHeaderConfig = {
  baseUrl: 'https://app.switchboard.test',
  mailbox: 'unsubscribe@switchboard.test',
  secret: 'unsub-test-secret',
};

export interface EngineHarness {
  db: Db;
  cipher: TokenCipher;
  queue: InProcessQueueDriver;
  providers: Map<string, MockEmailProvider>;
  providerFor: (identity: { address: string; provider: 'gmail' | 'mock' }) => MockEmailProvider;
  /** Mutable clock the tests advance. */
  clock: { now: Date };
  deps: DispatchDeps;
}

export function makeHarness(db: Db): EngineHarness {
  const cipher = new TokenCipher(ENGINE_SECRET);
  const clock = { now: new Date('2026-03-02T15:00:00.000Z') }; // a Monday, mid-day UTC
  const now = (): Date => clock.now;
  const queue = new InProcessQueueDriver({ mode: 'manual', now: () => clock.now.getTime() });
  const providers = new Map<string, MockEmailProvider>();
  const providerFor = (identity: { address: string; provider: 'gmail' | 'mock' }): MockEmailProvider => {
    const key = identity.address.toLowerCase();
    let p = providers.get(key);
    if (p === undefined) {
      p = new MockEmailProvider({ address: identity.address });
      providers.set(key, p);
    }
    return p;
  };
  const deps: DispatchDeps = {
    db,
    providerFor,
    cipher,
    queue,
    workerId: 'worker-test',
    now,
    unsubscribe: UNSUB_CONFIG,
  };
  return { db, cipher, queue, providers, providerFor, clock, deps };
}

let seq = 0;

export async function seedUser(db: Db, email = `rep${(seq += 1)}@switchboard.test`): Promise<string> {
  const rows = await db
    .insert(users)
    .values({ email, name: 'Rep', role: 'rep', idpSubject: `idp|${email}`, isActive: true })
    .returning({ id: users.id });
  return rows[0]!.id;
}

export async function seedLead(db: Db, name = 'Acme', opts: { dnc?: boolean } = {}): Promise<string> {
  const rows = await db
    .insert(leads)
    .values({ name, ...(opts.dnc === true ? { dnc: true } : {}) })
    .returning({ id: leads.id });
  return rows[0]!.id;
}

export async function seedContact(
  db: Db,
  leadId: string,
  email: string,
  opts: { dnc?: boolean; name?: string } = {},
): Promise<string> {
  const rows = await db
    .insert(contacts)
    .values({
      leadId,
      name: opts.name ?? 'Contact',
      emails: email.length > 0 ? [{ email, type: 'work' }] : [],
      ...(opts.dnc === true ? { dnc: true } : {}),
    })
    .returning({ id: contacts.id });
  return rows[0]!.id;
}

export async function seedAccount(
  db: Db,
  cipher: TokenCipher,
  userId: string,
  address = 'rep@mock.test',
): Promise<string> {
  const enc = cipher.encrypt({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    tokenType: 'Bearer',
  });
  const rows = await db
    .insert(emailAccounts)
    .values({ userId, address, provider: 'mock', syncStatus: 'LIVE', oauthTokens: enc })
    .returning({ id: emailAccounts.id });
  return rows[0]!.id;
}

export async function seedTemplate(
  db: Db,
  ownerId: string,
  opts: { subject?: string; body?: string } = {},
): Promise<string> {
  const rows = await db
    .insert(templates)
    .values({
      name: 'Seq template',
      channel: 'email',
      subject: opts.subject ?? 'Hi {{contact.name}}',
      body: opts.body ?? 'Hello {{lead.name}}',
      ownerId,
      shared: false,
    })
    .returning({ id: templates.id });
  return rows[0]!.id;
}

export interface StepSpec {
  type?: 'email' | 'call_task' | 'sms';
  delayHours?: number;
  templateId?: string | null;
  requiresReview?: boolean;
  condition?: Record<string, unknown> | null;
}

export async function seedSequence(
  db: Db,
  steps: StepSpec[],
  opts: { name?: string; status?: 'active' | 'archived' } = {},
): Promise<{ sequenceId: string; stepIds: string[] }> {
  const seqRows = await db
    .insert(sequences)
    .values({ name: opts.name ?? 'Onboarding', status: opts.status ?? 'active' })
    .returning({ id: sequences.id });
  const sequenceId = seqRows[0]!.id;
  const stepIds: string[] = [];
  let order = 0;
  for (const s of steps) {
    const rows = await db
      .insert(sequenceSteps)
      .values({
        sequenceId,
        sortOrder: order,
        type: s.type ?? 'email',
        delayHours: s.delayHours ?? 0,
        ...(s.templateId !== undefined ? { templateId: s.templateId } : {}),
        requiresReview: s.requiresReview ?? false,
        ...(s.condition !== undefined ? { condition: s.condition } : {}),
      })
      .returning({ id: sequenceSteps.id });
    stepIds.push(rows[0]!.id);
    order += 1;
  }
  return { sequenceId, stepIds };
}

export async function setOrgSettings(
  db: Db,
  opts: { dailySendCap?: number; companyTimezone?: string; sendingWindow?: unknown } = {},
): Promise<void> {
  await db.insert(orgSettings).values({
    dailySendCap: opts.dailySendCap ?? 200,
    companyTimezone: opts.companyTimezone ?? 'UTC',
    ...(opts.sendingWindow !== undefined
      ? { sendingWindow: opts.sendingWindow as Record<string, unknown> }
      : {}),
  });
}

// --- Inspection -------------------------------------------------------------

export async function intentState(
  db: Db,
  intentId: string,
): Promise<{ state: string; skipReason: string | null; providerMessageId: string | null }> {
  const rows = await db
    .select({
      state: sendIntents.state,
      skipReason: sendIntents.skipReason,
      providerMessageId: sendIntents.providerMessageId,
    })
    .from(sendIntents)
    .where(eq(sendIntents.id, intentId));
  return rows[0]!;
}

export async function intentsForEnrollment(
  db: Db,
  enrollmentId: string,
): Promise<{ id: string; state: string; channel: string; skipReason: string | null }[]> {
  return db
    .select({
      id: sendIntents.id,
      state: sendIntents.state,
      channel: sendIntents.channel,
      skipReason: sendIntents.skipReason,
    })
    .from(sendIntents)
    .where(eq(sendIntents.enrollmentId, enrollmentId));
}

export async function enrollmentState(
  db: Db,
  enrollmentId: string,
): Promise<{ state: string; pausedReason: string | null }> {
  const rows = await db
    .select({ state: sequenceEnrollments.state, pausedReason: sequenceEnrollments.pausedReason })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, enrollmentId));
  return rows[0]!;
}

export async function activityTypes(db: Db, leadId: string): Promise<string[]> {
  const rows = await db
    .select({ type: activities.type, occurredAt: activities.occurredAt })
    .from(activities)
    .where(eq(activities.leadId, leadId))
    .orderBy(activities.occurredAt);
  return rows.map((r) => r.type);
}

export async function countActivities(db: Db, leadId: string, type: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n FROM activities WHERE lead_id = ${leadId} AND type = ${type}
  `);
  return Number((result as { rows: Record<string, unknown>[] }).rows[0]!['n']);
}
