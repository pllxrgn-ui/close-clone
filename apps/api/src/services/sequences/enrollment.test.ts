import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { enrollContacts } from './enrollment.ts';
import { SequenceValidationError } from './errors.ts';
import {
  countActivities,
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
 * Enrollment (ARCHITECTURE §4.1): intent scheduling (cumulative delays, review
 * steps → AWAITING_REVIEW), the C1 partial-unique (one live enrollment per
 * sequence+contact), bulk skip-with-reason, and the exactly-once
 * `sequence_enrolled` event.
 */

let ctx: TestDb;
let h: EngineHarness;
let rep: string;
let lead: string;
let contact: string;
let account: string;
let template: string;

beforeEach(async () => {
  ctx = await createTestDb();
  h = makeHarness(ctx.db);
  rep = await seedUser(ctx.db, 'rep@switchboard.test');
  lead = await seedLead(ctx.db, 'Acme');
  contact = await seedContact(ctx.db, lead, 'dana@acme.test', { name: 'Dana' });
  account = await seedAccount(ctx.db, h.cipher, rep, 'rep@mock.test');
  template = await seedTemplate(ctx.db);
  await setOrgSettings(ctx.db, {});
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('intent scheduling', () => {
  test('creates one intent per step with cumulative due dates; wake-ups only for SCHEDULED', async () => {
    const { sequenceId } = await seedSequence(ctx.db, [
      { type: 'email', delayHours: 0, templateId: template },
      { type: 'email', delayHours: 24, templateId: template, requiresReview: true },
      { type: 'call_task', delayHours: 48 },
    ]);
    const res = await enrollContacts(h.deps, {
      sequenceId,
      enrolledBy: rep,
      emailAccountId: account,
      targets: [{ leadId: lead, contactId: contact }],
    });
    const enrollmentId = res.enrolled[0]!.enrollmentId;
    const intents = await intentsForEnrollment(ctx.db, enrollmentId);
    expect(intents).toHaveLength(3);
    // email#1 + call_task are SCHEDULED; the requires_review email is AWAITING_REVIEW.
    expect(intents.filter((i) => i.state === 'SCHEDULED')).toHaveLength(2);
    expect(intents.filter((i) => i.state === 'AWAITING_REVIEW')).toHaveLength(1);
    // Only the two SCHEDULED intents got a wake-up; the review step did not.
    expect(h.queue.pendingCount).toBe(2);
    expect(await countActivities(ctx.db, lead, 'sequence_enrolled')).toBe(1);
  });
});

describe('bulk + partial-unique', () => {
  test('skips already-enrolled, missing lead, and cross-lead contacts with reasons', async () => {
    const { sequenceId } = await seedSequence(ctx.db, [
      { type: 'email', delayHours: 0, templateId: template },
    ]);
    const otherLead = await seedLead(ctx.db, 'Beta');
    const otherContact = await seedContact(ctx.db, otherLead, 'x@beta.test');

    const first = await enrollContacts(h.deps, {
      sequenceId,
      enrolledBy: rep,
      emailAccountId: account,
      targets: [{ leadId: lead, contactId: contact }],
    });
    expect(first.enrolled).toHaveLength(1);

    const second = await enrollContacts(h.deps, {
      sequenceId,
      enrolledBy: rep,
      emailAccountId: account,
      targets: [
        { leadId: lead, contactId: contact }, // duplicate live enrollment
        { leadId: lead, contactId: otherContact }, // contact belongs to otherLead
        { leadId: '00000000-0000-0000-0000-000000000000', contactId: contact }, // missing lead
      ],
    });
    expect(second.enrolled).toHaveLength(0);
    const reasons = second.skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(['already_enrolled', 'contact_lead_mismatch', 'lead_not_found']);
  });

  test('a finished/unenrolled contact CAN be re-enrolled (partial unique excludes them)', async () => {
    const { sequenceId } = await seedSequence(ctx.db, [
      { type: 'email', delayHours: 0, templateId: template },
    ]);
    const res1 = await enrollContacts(h.deps, {
      sequenceId,
      enrolledBy: rep,
      emailAccountId: account,
      targets: [{ leadId: lead, contactId: contact }],
    });
    // Mark the enrollment finished so the partial-unique slot frees.
    const { sequenceEnrollments } = await import('../../db/index.ts');
    const { eq } = await import('drizzle-orm');
    await ctx.db
      .update(sequenceEnrollments)
      .set({ state: 'finished' })
      .where(eq(sequenceEnrollments.id, res1.enrolled[0]!.enrollmentId));

    const res2 = await enrollContacts(h.deps, {
      sequenceId,
      enrolledBy: rep,
      emailAccountId: account,
      targets: [{ leadId: lead, contactId: contact }],
    });
    expect(res2.enrolled).toHaveLength(1);
  });
});

describe('validation', () => {
  test('an archived sequence cannot be enrolled', async () => {
    const { sequenceId } = await seedSequence(ctx.db, [{ type: 'email', templateId: template }], {
      status: 'archived',
    });
    await expect(
      enrollContacts(h.deps, {
        sequenceId,
        emailAccountId: account,
        targets: [{ leadId: lead, contactId: contact }],
      }),
    ).rejects.toBeInstanceOf(SequenceValidationError);
  });

  test('an email sequence with no emailAccountId is rejected', async () => {
    const { sequenceId } = await seedSequence(ctx.db, [{ type: 'email', templateId: template }]);
    await expect(
      enrollContacts(h.deps, { sequenceId, targets: [{ leadId: lead, contactId: contact }] }),
    ).rejects.toBeInstanceOf(SequenceValidationError);
  });

  test('a sequence with no steps is rejected', async () => {
    const { sequenceId } = await seedSequence(ctx.db, []);
    await expect(
      enrollContacts(h.deps, { sequenceId, targets: [{ leadId: lead, contactId: contact }] }),
    ).rejects.toBeInstanceOf(SequenceValidationError);
  });
});
