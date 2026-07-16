import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq, isNull, sql } from 'drizzle-orm';
import {
  calls,
  contacts,
  customFieldDefs,
  emailAccounts,
  emailMessages,
  leads,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  sendIntents,
  smsMessages,
  suppressions,
  users,
  webhookInbox,
} from './index.ts';
import { createTestDb, type TestDb } from './test-helpers.ts';

let ctx: TestDb;
beforeEach(async () => {
  ctx = await createTestDb();
});
afterEach(async () => {
  await ctx.close();
});

const EXPECTED_TABLES = [
  'activities',
  'api_tokens',
  'audit_log',
  'calls',
  'contacts',
  'custom_field_defs',
  'email_accounts',
  'email_messages',
  'email_threads',
  'imports',
  'lead_statuses',
  'leads',
  'notes',
  'opportunities',
  'opportunity_stages',
  'org_settings',
  'send_intents',
  'sequence_enrollments',
  'sequence_steps',
  'sequences',
  'smart_views',
  'sms_messages',
  'snippets',
  'suppressions',
  'sync_events',
  'tasks',
  'templates',
  'users',
  'webhook_deliveries',
  'webhook_inbox',
  'webhook_subscriptions',
];

// --- FK seed helpers --------------------------------------------------------

async function seedUser(suffix: string): Promise<string> {
  const [u] = await ctx.db
    .insert(users)
    .values({
      email: `user-${suffix}@x.test`,
      name: `U${suffix}`,
      role: 'rep',
      idpSubject: `idp-${suffix}`,
    })
    .returning({ id: users.id });
  return u!.id;
}

async function seedLead(): Promise<string> {
  const [l] = await ctx.db.insert(leads).values({ name: 'Lead' }).returning({ id: leads.id });
  return l!.id;
}

async function seedContact(leadId: string): Promise<string> {
  const [c] = await ctx.db
    .insert(contacts)
    .values({ leadId, name: 'Contact' })
    .returning({ id: contacts.id });
  return c!.id;
}

describe('migrations apply cleanly from empty', () => {
  test('all 31 C1 tables exist in the public schema', async () => {
    const rows = await ctx.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const names = rows.rows.map((r) => r.table_name);
    expect(names).toEqual(EXPECTED_TABLES);
  });
});

describe('C1 unique constraints (insert dup → error)', () => {
  test('users.email is unique and case-insensitive (citext)', async () => {
    await ctx.db
      .insert(users)
      .values({ email: 'Dup@X.test', name: 'A', role: 'rep', idpSubject: 'a' });
    await expect(
      ctx.db.insert(users).values({ email: 'dup@x.test', name: 'B', role: 'rep', idpSubject: 'b' }),
    ).rejects.toThrow();
  });

  test('users.idp_subject is unique', async () => {
    await ctx.db
      .insert(users)
      .values({ email: 'a1@x.test', name: 'A', role: 'rep', idpSubject: 's' });
    await expect(
      ctx.db.insert(users).values({ email: 'a2@x.test', name: 'B', role: 'rep', idpSubject: 's' }),
    ).rejects.toThrow();
  });

  test('custom_field_defs (entity, key) is unique', async () => {
    await ctx.db
      .insert(customFieldDefs)
      .values({ entity: 'lead', key: 'k', label: 'K', type: 'text' });
    await expect(
      ctx.db
        .insert(customFieldDefs)
        .values({ entity: 'lead', key: 'k', label: 'K2', type: 'text' }),
    ).rejects.toThrow();
    // Same key under a different entity is allowed.
    await expect(
      ctx.db
        .insert(customFieldDefs)
        .values({ entity: 'contact', key: 'k', label: 'K3', type: 'text' }),
    ).resolves.toBeDefined();
  });

  test('email_messages (account_id, rfc_message_id) — the dedupe backstop', async () => {
    const userId = await seedUser('em');
    const [acct] = await ctx.db
      .insert(emailAccounts)
      .values({ userId, address: 'box@x.test', provider: 'mock' })
      .returning({ id: emailAccounts.id });
    const accountId = acct!.id;
    await ctx.db
      .insert(emailMessages)
      .values({ accountId, rfcMessageId: '<m1@x>', direction: 'in' });
    await expect(
      ctx.db.insert(emailMessages).values({ accountId, rfcMessageId: '<m1@x>', direction: 'in' }),
    ).rejects.toThrow();
  });

  test('suppressions (kind, value) is unique and case-insensitive', async () => {
    await ctx.db
      .insert(suppressions)
      .values({ kind: 'email', value: 'Foo@X.test', source: 'manual' });
    await expect(
      ctx.db.insert(suppressions).values({ kind: 'email', value: 'foo@x.test', source: 'bounce' }),
    ).rejects.toThrow();
    // Same value under a different kind is allowed.
    await expect(
      ctx.db.insert(suppressions).values({ kind: 'phone', value: 'foo@x.test', source: 'manual' }),
    ).resolves.toBeDefined();
  });

  test('send_intents (enrollment_id, step_id) — never-sends-twice backstop', async () => {
    const leadId = await seedLead();
    const contactId = await seedContact(leadId);
    const [seq] = await ctx.db
      .insert(sequences)
      .values({ name: 'Seq' })
      .returning({ id: sequences.id });
    const [step] = await ctx.db
      .insert(sequenceSteps)
      .values({ sequenceId: seq!.id, type: 'email' })
      .returning({ id: sequenceSteps.id });
    const [enr] = await ctx.db
      .insert(sequenceEnrollments)
      .values({ sequenceId: seq!.id, leadId, contactId })
      .returning({ id: sequenceEnrollments.id });
    await ctx.db.insert(sendIntents).values({
      enrollmentId: enr!.id,
      stepId: step!.id,
      channel: 'email',
      dueAt: '2026-06-01T00:00:00Z',
    });
    await expect(
      ctx.db.insert(sendIntents).values({
        enrollmentId: enr!.id,
        stepId: step!.id,
        channel: 'email',
        dueAt: '2026-06-02T00:00:00Z',
      }),
    ).rejects.toThrow();
  });

  test('sequence_enrollments partial unique — one live per (sequence, contact)', async () => {
    const leadId = await seedLead();
    const contactId = await seedContact(leadId);
    const [seq] = await ctx.db
      .insert(sequences)
      .values({ name: 'Seq' })
      .returning({ id: sequences.id });
    await ctx.db
      .insert(sequenceEnrollments)
      .values({ sequenceId: seq!.id, leadId, contactId, state: 'active' });
    // Second active enrollment for the same (sequence, contact) is rejected.
    await expect(
      ctx.db
        .insert(sequenceEnrollments)
        .values({ sequenceId: seq!.id, leadId, contactId, state: 'active' }),
    ).rejects.toThrow();
    // But a finished enrollment (outside the partial predicate) is allowed.
    await expect(
      ctx.db
        .insert(sequenceEnrollments)
        .values({ sequenceId: seq!.id, leadId, contactId, state: 'finished' }),
    ).resolves.toBeDefined();
  });

  test('calls.twilio_sid and sms_messages.provider_sid are unique', async () => {
    const leadId = await seedLead();
    await ctx.db
      .insert(calls)
      .values({ leadId, direction: 'outbound', status: 'completed', twilioSid: 'CA1' });
    await expect(
      ctx.db
        .insert(calls)
        .values({ leadId, direction: 'outbound', status: 'completed', twilioSid: 'CA1' }),
    ).rejects.toThrow();
    await ctx.db.insert(smsMessages).values({
      leadId,
      direction: 'outbound',
      fromNumber: '+1',
      toNumber: '+2',
      status: 'sent',
      providerSid: 'SM1',
    });
    await expect(
      ctx.db.insert(smsMessages).values({
        leadId,
        direction: 'outbound',
        fromNumber: '+1',
        toNumber: '+3',
        status: 'sent',
        providerSid: 'SM1',
      }),
    ).rejects.toThrow();
  });

  test('webhook_inbox (provider, provider_event_id) is unique', async () => {
    await ctx.db.insert(webhookInbox).values({ provider: 'twilio', providerEventId: 'evt1' });
    await expect(
      ctx.db.insert(webhookInbox).values({ provider: 'twilio', providerEventId: 'evt1' }),
    ).rejects.toThrow();
    // Same event id under a different provider is allowed.
    await expect(
      ctx.db.insert(webhookInbox).values({ provider: 'gmail', providerEventId: 'evt1' }),
    ).resolves.toBeDefined();
  });
});

describe('soft delete behavior', () => {
  test('deleted_at marks a lead without removing the row', async () => {
    const leadId = await seedLead();
    await ctx.db
      .update(leads)
      .set({ deletedAt: '2026-05-01T00:00:00Z' })
      .where(eq(leads.id, leadId));

    // Row still physically present …
    const all = await ctx.db.select({ id: leads.id }).from(leads).where(eq(leads.id, leadId));
    expect(all).toHaveLength(1);
    // … but excluded by the standard "live rows" predicate.
    const live = await ctx.db.select({ id: leads.id }).from(leads).where(isNull(leads.deletedAt));
    expect(live.find((r) => r.id === leadId)).toBeUndefined();
  });
});
