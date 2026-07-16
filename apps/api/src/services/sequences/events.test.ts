import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { enrollContacts } from './enrollment.ts';
import { processIntent } from './dispatch.ts';
import {
  activityTypes,
  countActivities,
  enrollmentState,
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
 * C4 timeline events exactly once (acceptance). A two-step email sequence run to
 * completion emits `sequence_enrolled` once, `sequence_step_sent` once per sent
 * step, and `sequence_finished` once — no duplicates on replay/idempotent re-claim.
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
  contact = await seedContact(ctx.db, lead, 'dana@acme.test');
  account = await seedAccount(ctx.db, h.cipher, rep, 'rep@mock.test');
  template = await seedTemplate(ctx.db, rep);
  await setOrgSettings(ctx.db, {});
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('C4 exactly-once', () => {
  test('a two-step sequence emits enrolled×1, step_sent×2, finished×1', async () => {
    const { sequenceId } = await seedSequence(ctx.db, [
      { type: 'email', delayHours: 0, templateId: template },
      { type: 'email', delayHours: 0, templateId: template },
    ]);
    const res = await enrollContacts(h.deps, {
      sequenceId,
      enrolledBy: rep,
      emailAccountId: account,
      targets: [{ leadId: lead, contactId: contact }],
    });
    const enrollmentId = res.enrolled[0]!.enrollmentId;
    const intents = await intentsForEnrollment(ctx.db, enrollmentId);
    expect(intents).toHaveLength(2);

    // Send both steps; re-claim each once (idempotent replay must not double-write).
    for (const i of intents) {
      expect((await processIntent(h.deps, i.id)).kind).toBe('sent');
      expect((await processIntent(h.deps, i.id)).kind).toBe('not_claimed');
    }

    expect((await enrollmentState(ctx.db, enrollmentId)).state).toBe('finished');
    expect(await countActivities(ctx.db, lead, 'sequence_enrolled')).toBe(1);
    expect(await countActivities(ctx.db, lead, 'sequence_step_sent')).toBe(2);
    expect(await countActivities(ctx.db, lead, 'sequence_finished')).toBe(1);

    // No stray events beyond the expected set (sequence emits its own events, not
    // a duplicate email_sent — that stays the sync/thread concern).
    const types = (await activityTypes(ctx.db, lead)).sort();
    expect(types).toEqual(
      ['sequence_enrolled', 'sequence_finished', 'sequence_step_sent', 'sequence_step_sent'].sort(),
    );
  });
});
