import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { contacts, leads, orgSettings, suppressions } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { enrollContacts } from './enrollment.ts';
import { processIntent } from './dispatch.ts';
import { registerSequenceWorker } from './worker.ts';
import {
  activityTypes,
  countActivities,
  enrollmentState,
  intentState,
  intentsForEnrollment,
  makeHarness,
  seedAccount,
  seedContact,
  seedLead,
  seedSequence,
  seedTemplate,
  seedUser,
  setOrgSettings,
  type EngineHarness,
} from './test-helpers.ts';

/**
 * The send transaction (ARCHITECTURE §4.3, CONTRACTS §C6). Covers the happy send +
 * completion, I-SEND-1 (never twice), I-SEND-3/I-DNC (suppression + DNC inside the
 * txn), I-SEND-4 (window + per-mailbox cap), and requires_review (AWAITING_REVIEW
 * never auto-sends). Everything runs under MOCK_MODE semantics (mock provider) with
 * the in-process queue driver.
 */

let ctx: TestDb;
let h: EngineHarness;
let rep: string;
let lead: string;
let contact: string;
let account: string;
let template: string;

async function enrollOneEmailStep(delayHours = 0): Promise<{ enrollmentId: string; intentId: string }> {
  const { sequenceId } = await seedSequence(ctx.db, [{ type: 'email', delayHours, templateId: template }]);
  const res = await enrollContacts(h.deps, {
    sequenceId,
    enrolledBy: rep,
    emailAccountId: account,
    targets: [{ leadId: lead, contactId: contact }],
  });
  const enrollmentId = res.enrolled[0]!.enrollmentId;
  const intents = await intentsForEnrollment(ctx.db, enrollmentId);
  return { enrollmentId, intentId: intents[0]!.id };
}

beforeEach(async () => {
  ctx = await createTestDb();
  h = makeHarness(ctx.db);
  rep = await seedUser(ctx.db, 'rep@switchboard.test');
  lead = await seedLead(ctx.db, 'Acme');
  contact = await seedContact(ctx.db, lead, 'dana@acme.test', { name: 'Dana' });
  account = await seedAccount(ctx.db, h.cipher, rep, 'rep@mock.test');
  template = await seedTemplate(ctx.db, rep, { subject: 'Hi {{contact.name}}', body: 'Hello {{lead.name}}' });
  await setOrgSettings(ctx.db, { dailySendCap: 200, companyTimezone: 'UTC' });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('happy path + completion', () => {
  test('sends the step, marks SENT, finishes the enrollment, emits events once', async () => {
    const { enrollmentId, intentId } = await enrollOneEmailStep(0);
    const result = await processIntent(h.deps, intentId);

    expect(result.kind).toBe('sent');
    const state = await intentState(ctx.db, intentId);
    expect(state.state).toBe('SENT');
    expect(state.providerMessageId).toBeTruthy();

    const provider = h.providers.get('rep@mock.test')!;
    expect(provider.deliveredCount).toBe(1);

    // Sole-step enrollment → finished; timeline has enrolled/step_sent/finished once.
    expect((await enrollmentState(ctx.db, enrollmentId)).state).toBe('finished');
    expect(await countActivities(ctx.db, lead, 'sequence_enrolled')).toBe(1);
    expect(await countActivities(ctx.db, lead, 'sequence_step_sent')).toBe(1);
    expect(await countActivities(ctx.db, lead, 'sequence_finished')).toBe(1);
  });

  test('the outbound draft carries List-Unsubscribe (mailto + one-click https)', async () => {
    const { intentId } = await enrollOneEmailStep(0);
    let captured: Record<string, string> | undefined;
    const provider = h.providerFor({ address: 'rep@mock.test', provider: 'mock' });
    provider.setSendInterceptor((_key, draft) => {
      captured = draft.headers;
    });
    await processIntent(h.deps, intentId);
    expect(captured?.['List-Unsubscribe']).toMatch(/mailto:/);
    expect(captured?.['List-Unsubscribe']).toMatch(/https:\/\/app\.switchboard\.test\/api\/v1\/unsubscribe\//);
    expect(captured?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  test('drives end-to-end through the queue worker + tick', async () => {
    registerSequenceWorker(h.deps);
    const { intentId } = await enrollOneEmailStep(0);
    // The enroller enqueued a delay-0 wake-up; tick runs it.
    expect(await h.queue.tick()).toBe(1);
    expect((await intentState(ctx.db, intentId)).state).toBe('SENT');
  });
});

describe('I-SEND-1 (never twice)', () => {
  test('a second claim of the same intent is a no-op; provider called once', async () => {
    const { intentId } = await enrollOneEmailStep(0);
    const first = await processIntent(h.deps, intentId);
    const second = await processIntent(h.deps, intentId);
    expect(first.kind).toBe('sent');
    expect(second.kind).toBe('not_claimed');
    const provider = h.providers.get('rep@mock.test')!;
    expect(provider.sendCallCountForKey(intentId)).toBeLessThanOrEqual(1);
    expect(provider.deliveredCount).toBe(1);
  });

  test('concurrent double-claim → exactly one SENT, one provider send', async () => {
    const { intentId } = await enrollOneEmailStep(0);
    const results = await Promise.allSettled([
      processIntent(h.deps, intentId),
      processIntent(h.deps, intentId),
    ]);
    const kinds = results.map((r) => (r.status === 'fulfilled' ? r.value.kind : 'rejected'));
    expect(kinds.filter((k) => k === 'sent')).toHaveLength(1);
    const provider = h.providers.get('rep@mock.test')!;
    expect(provider.sendCallCountForKey(intentId)).toBeLessThanOrEqual(1);
    expect(provider.deliveredCount).toBe(1);
    expect((await intentState(ctx.db, intentId)).state).toBe('SENT');
  });
});

describe('I-SEND-3 / I-DNC (suppression + DNC inside the claim txn)', () => {
  test('an active suppression on the recipient BLOCKS the send', async () => {
    const { intentId } = await enrollOneEmailStep(0);
    await ctx.db.insert(suppressions).values({ kind: 'email', value: 'dana@acme.test', source: 'manual' });
    const result = await processIntent(h.deps, intentId);
    expect(result.kind).toBe('blocked');
    const state = await intentState(ctx.db, intentId);
    expect(state.state).toBe('BLOCKED');
    expect(state.skipReason).toBe('suppressed');
    expect(h.providers.get('rep@mock.test')?.deliveredCount ?? 0).toBe(0);
  });

  test('a RELEASED suppression does NOT block', async () => {
    const { intentId } = await enrollOneEmailStep(0);
    await ctx.db
      .insert(suppressions)
      .values({ kind: 'email', value: 'dana@acme.test', source: 'manual', releasedAt: new Date().toISOString() });
    const result = await processIntent(h.deps, intentId);
    expect(result.kind).toBe('sent');
  });

  test('lead DNC blocks the send', async () => {
    await ctx.db.update(leads).set({ dnc: true }).where(eq(leads.id, lead));
    const { intentId } = await enrollOneEmailStep(0);
    const result = await processIntent(h.deps, intentId);
    expect(result.kind).toBe('blocked');
    expect((await intentState(ctx.db, intentId)).skipReason).toBe('lead_dnc');
  });

  test('contact DNC blocks the send', async () => {
    await ctx.db.update(contacts).set({ dnc: true }).where(eq(contacts.id, contact));
    const { intentId } = await enrollOneEmailStep(0);
    const result = await processIntent(h.deps, intentId);
    expect(result.kind).toBe('blocked');
    expect((await intentState(ctx.db, intentId)).skipReason).toBe('contact_dnc');
  });
});

describe('I-SEND-4 (window + per-mailbox daily cap)', () => {
  test('a send outside the org window is deferred, not sent', async () => {
    // Window 09:00–10:00 UTC; harness clock is 15:00 UTC → outside.
    await ctx.db
      .update(orgSettings)
      .set({ sendingWindow: { start: '09:00', end: '10:00' } });
    const { intentId } = await enrollOneEmailStep(0);
    const result = await processIntent(h.deps, intentId);
    expect(result.kind).toBe('deferred');
    expect(result.reason).toBe('outside_window');
    const state = await intentState(ctx.db, intentId);
    expect(state.state).toBe('SCHEDULED'); // back to schedulable, later due
    expect(h.providers.get('rep@mock.test')?.deliveredCount ?? 0).toBe(0);
  });

  test('inside the window it sends', async () => {
    await ctx.db
      .update(orgSettings)
      .set({ sendingWindow: { start: '00:00', end: '23:59' } });
    const { intentId } = await enrollOneEmailStep(0);
    expect((await processIntent(h.deps, intentId)).kind).toBe('sent');
  });

  test('the per-mailbox daily cap defers once reached; counter is per-txn', async () => {
    await ctx.db.update(orgSettings).set({ dailySendCap: 1 });
    // First contact: consumes the cap.
    const first = await enrollOneEmailStep(0);
    expect((await processIntent(h.deps, first.intentId)).kind).toBe('sent');

    // Second contact on the SAME mailbox: over cap → deferred.
    const contact2 = await seedContact(ctx.db, lead, 'evan@acme.test', { name: 'Evan' });
    const { sequenceId } = await seedSequence(ctx.db, [{ type: 'email', delayHours: 0, templateId: template }]);
    const res = await enrollContacts(h.deps, {
      sequenceId,
      enrolledBy: rep,
      emailAccountId: account,
      targets: [{ leadId: lead, contactId: contact2 }],
    });
    const intent2 = (await intentsForEnrollment(ctx.db, res.enrolled[0]!.enrollmentId))[0]!.id;
    const result = await processIntent(h.deps, intent2);
    expect(result.kind).toBe('deferred');
    expect(result.reason).toBe('cap_exceeded');
    expect(h.providers.get('rep@mock.test')!.deliveredCount).toBe(1);
  });
});

describe('requires_review', () => {
  test('a requires_review step is AWAITING_REVIEW and never auto-claims', async () => {
    const { sequenceId } = await seedSequence(ctx.db, [
      { type: 'email', delayHours: 0, templateId: template, requiresReview: true },
    ]);
    const res = await enrollContacts(h.deps, {
      sequenceId,
      enrolledBy: rep,
      emailAccountId: account,
      targets: [{ leadId: lead, contactId: contact }],
    });
    const enrollmentId = res.enrolled[0]!.enrollmentId;
    const intents = await intentsForEnrollment(ctx.db, enrollmentId);
    expect(intents[0]!.state).toBe('AWAITING_REVIEW');
    // No wake-up was enqueued for a review step.
    expect(h.queue.pendingCount).toBe(0);
    // Even a direct claim attempt cannot send it (WHERE state='SCHEDULED').
    const result = await processIntent(h.deps, intents[0]!.id);
    expect(result.kind).toBe('not_claimed');
    expect(h.providers.get('rep@mock.test')?.deliveredCount ?? 0).toBe(0);
  });
});
