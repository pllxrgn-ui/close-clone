import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { enrollContacts } from './enrollment.ts';
import { processIntent } from './dispatch.ts';
import {
  applyUnsubscribe,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
} from './unsubscribe.ts';
import { isEmailSuppressed } from './suppression.ts';
import {
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
 * I-SEND-5 (unsubscribe). Either List-Unsubscribe path lands in `applyUnsubscribe`,
 * which suppresses globally, emits `unsubscribed` + `suppression_added` + (via the
 * pause) `sequence_paused`, exactly once — and a later send to that address is
 * blocked by the suppression rail.
 */

let ctx: TestDb;
let h: EngineHarness;
let rep: string;
let lead: string;
let contact: string;
let account: string;
let template: string;

async function enroll(): Promise<{ enrollmentId: string; intentId: string }> {
  const { sequenceId } = await seedSequence(ctx.db, [{ type: 'email', delayHours: 0, templateId: template }]);
  const res = await enrollContacts(h.deps, {
    sequenceId,
    enrolledBy: rep,
    emailAccountId: account,
    targets: [{ leadId: lead, contactId: contact }],
  });
  const enrollmentId = res.enrolled[0]!.enrollmentId;
  const intentId = (await intentsForEnrollment(ctx.db, enrollmentId))[0]!.id;
  return { enrollmentId, intentId };
}

beforeEach(async () => {
  ctx = await createTestDb();
  h = makeHarness(ctx.db);
  rep = await seedUser(ctx.db, 'rep@switchboard.test');
  lead = await seedLead(ctx.db, 'Acme');
  contact = await seedContact(ctx.db, lead, 'dana@acme.test', { name: 'Dana' });
  account = await seedAccount(ctx.db, h.cipher, rep, 'rep@mock.test');
  template = await seedTemplate(ctx.db);
  await setOrgSettings(ctx.db, { dailySendCap: 200, companyTimezone: 'UTC' });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('one-click token', () => {
  test('round-trips the recipient address', () => {
    const token = createUnsubscribeToken('secret', 'Dana@Acme.test');
    expect(verifyUnsubscribeToken('secret', token)).toBe('dana@acme.test');
  });

  test('rejects a tampered token or wrong secret', () => {
    const token = createUnsubscribeToken('secret', 'dana@acme.test');
    expect(verifyUnsubscribeToken('secret', `${token}x`)).toBeNull();
    expect(verifyUnsubscribeToken('other', token)).toBeNull();
    expect(verifyUnsubscribeToken('secret', 'garbage')).toBeNull();
  });
});

describe('applyUnsubscribe', () => {
  test('suppresses globally, emits events once, pauses the enrollment', async () => {
    const { enrollmentId } = await enroll();
    const result = await applyUnsubscribe(ctx.db, { email: 'dana@acme.test' });

    expect(result.changed).toBe(true);
    expect(result.affectedLeadIds).toEqual([lead]);
    expect(result.pausedEnrollmentIds).toEqual([enrollmentId]);

    expect(await isEmailSuppressed(ctx.db, 'dana@acme.test')).toBe(true);
    expect(await countActivities(ctx.db, lead, 'unsubscribed')).toBe(1);
    expect(await countActivities(ctx.db, lead, 'suppression_added')).toBe(1);
    expect(await countActivities(ctx.db, lead, 'sequence_paused')).toBe(1);

    const enr = await enrollmentState(ctx.db, enrollmentId);
    expect(enr.state).toBe('paused');
    expect(enr.pausedReason).toBe('unsubscribe');
  });

  test('after unsubscribe the enrollment is paused so its intent SKIPs', async () => {
    const { intentId } = await enroll();
    await applyUnsubscribe(ctx.db, { email: 'dana@acme.test' });
    const skip = await processIntent(h.deps, intentId);
    expect(skip.kind).toBe('skipped');
    expect(await isEmailSuppressed(ctx.db, 'dana@acme.test')).toBe(true);
  });

  test('a repeat unsubscribe is idempotent (no duplicate timeline events)', async () => {
    await enroll();
    await applyUnsubscribe(ctx.db, { email: 'dana@acme.test' });
    const second = await applyUnsubscribe(ctx.db, { email: 'dana@acme.test' });
    expect(second.changed).toBe(false);
    expect(await countActivities(ctx.db, lead, 'unsubscribed')).toBe(1);
    expect(await countActivities(ctx.db, lead, 'suppression_added')).toBe(1);
  });

  test('unsubscribing an unknown address suppresses globally with no timeline', async () => {
    const result = await applyUnsubscribe(ctx.db, { email: 'stranger@nowhere.test' });
    expect(result.changed).toBe(true);
    expect(result.affectedLeadIds).toEqual([]);
    expect(await isEmailSuppressed(ctx.db, 'stranger@nowhere.test')).toBe(true);
  });
});

describe('intent-level suppression after unsubscribe', () => {
  test('a newly-enrolled contact with a suppressed address is BLOCKED at send', async () => {
    // Suppress first, then enroll a fresh contact/lead using that address.
    await applyUnsubscribe(ctx.db, { email: 'zed@acme.test' });
    const lead2 = await seedLead(ctx.db, 'Beta');
    const contact2 = await seedContact(ctx.db, lead2, 'zed@acme.test', { name: 'Zed' });
    const { sequenceId } = await seedSequence(ctx.db, [{ type: 'email', delayHours: 0, templateId: template }]);
    const res = await enrollContacts(h.deps, {
      sequenceId,
      enrolledBy: rep,
      emailAccountId: account,
      targets: [{ leadId: lead2, contactId: contact2 }],
    });
    const intentId = (await intentsForEnrollment(ctx.db, res.enrolled[0]!.enrollmentId))[0]!.id;
    const result = await processIntent(h.deps, intentId);
    expect(result.kind).toBe('blocked');
    expect((await intentState(ctx.db, intentId)).skipReason).toBe('suppressed');
  });
});
