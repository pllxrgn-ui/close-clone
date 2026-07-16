import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { EmailProvider, OutboundEmail } from '@switchboard/shared/providers';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { ingestMessage, type IngestDeps } from '../sync/ingest.ts';
import type { LeadMatcher, MatchDecision } from '../sync/matcher.ts';
import { makeRaw } from '../email/test-helpers.ts';
import { enrollContacts } from './enrollment.ts';
import { processIntent, type DispatchDeps } from './dispatch.ts';
import { pauseActiveEnrollments, pauseOnInboundReply, recordBounceAndPause } from './pause.ts';
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
 * I-SEND-2 (never after reply/bounce). The enrollment row lock in the send
 * transaction serialises against the pause: a pause committed before the claim's
 * re-check is seen (SKIP); a pause landing DURING the network send window (phase B)
 * is caught by the phase-C re-check under the same lock, so no intent reaches SENT
 * after `sequence_paused` commits.
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

describe('reply committed before the claim', () => {
  test('a reply pauses the enrollment; the due intent then SKIPs (never sends)', async () => {
    const { enrollmentId, intentId } = await enroll();
    // Reply lands and is processed before the intent is claimed.
    await ctx.db.transaction(async (tx) => {
      await pauseOnInboundReply(tx as never, lead);
    });
    const result = await processIntent(h.deps, intentId);
    expect(result.kind).toBe('skipped');
    expect(result.reason).toBe('enrollment_paused');
    expect((await intentState(ctx.db, intentId)).state).toBe('SKIPPED');
    expect(h.providers.get('rep@mock.test')?.deliveredCount ?? 0).toBe(0);

    const enr = await enrollmentState(ctx.db, enrollmentId);
    expect(enr.state).toBe('paused');
    expect(enr.pausedReason).toBe('reply');
    expect(await countActivities(ctx.db, lead, 'sequence_paused')).toBe(1);
  });

  test('pausing twice emits sequence_paused exactly once (idempotent)', async () => {
    const { enrollmentId } = await enroll();
    await ctx.db.transaction(async (tx) => pauseActiveEnrollments(tx as never, { leadId: lead }, 'reply'));
    await ctx.db.transaction(async (tx) => pauseActiveEnrollments(tx as never, { leadId: lead }, 'reply'));
    expect((await enrollmentState(ctx.db, enrollmentId)).state).toBe('paused');
    expect(await countActivities(ctx.db, lead, 'sequence_paused')).toBe(1);
  });
});

describe('reply via the ingest seam', () => {
  test('an inbound message matched to the lead pauses its active enrollments', async () => {
    const { enrollmentId } = await enroll();
    const matcher: LeadMatcher = {
      async match(): Promise<MatchDecision> {
        return { triageStatus: 'matched', leadId: lead };
      },
    };
    const deps: IngestDeps = {
      matcher,
      onInboundMatched: async (exec, cex) => {
        await pauseOnInboundReply(exec, cex.leadId);
      },
    };
    await ctx.db.transaction(async (tx) => {
      await ingestMessage(tx as never, deps, account, makeRaw({ direction: 'in', from: 'dana@acme.test' }));
    });
    expect((await enrollmentState(ctx.db, enrollmentId)).state).toBe('paused');
    expect(await countActivities(ctx.db, lead, 'sequence_paused')).toBe(1);
  });
});

describe('reply during the claim window (phase B)', () => {
  test('a pause committed mid-send prevents the intent from reaching SENT', async () => {
    const { enrollmentId, intentId } = await enroll();

    // A provider whose send() pauses the enrollment WHILE the network call is in
    // flight (between the claim commit and the SENT-marking txn), then delegates.
    const realFor = h.providerFor;
    let paused = false;
    const wrappingFor = (identity: { address: string; provider: 'gmail' | 'mock' }): EmailProvider => {
      const real = realFor(identity);
      return {
        ...real,
        send: async (tokens, draft: OutboundEmail, key: string) => {
          if (!paused) {
            paused = true;
            await ctx.db.transaction(async (tx) => pauseActiveEnrollments(tx as never, { leadId: lead }, 'reply'));
          }
          return real.send(tokens, draft, key);
        },
      } as EmailProvider;
    };
    const deps: DispatchDeps = { ...h.deps, providerFor: wrappingFor };

    const result = await processIntent(deps, intentId);
    expect(result.kind).toBe('paused_during_send');
    // The intent never reaches SENT (I-SEND-2), even though the provider was hit.
    expect((await intentState(ctx.db, intentId)).state).toBe('SKIPPED');
    expect(h.providers.get('rep@mock.test')!.deliveredCount).toBe(1);
    expect((await enrollmentState(ctx.db, enrollmentId)).state).toBe('paused');
    // No sequence_step_sent was written.
    expect(await countActivities(ctx.db, lead, 'sequence_step_sent')).toBe(0);
  });
});

describe('bounce', () => {
  test('a bounce records email_bounced + sequence_paused and pauses the enrollment', async () => {
    const { enrollmentId, intentId } = await enroll();
    await recordBounceAndPause(ctx.db, { leadId: lead, contactId: contact, reason: 'mailbox full' });

    expect(await countActivities(ctx.db, lead, 'email_bounced')).toBe(1);
    expect(await countActivities(ctx.db, lead, 'sequence_paused')).toBe(1);
    const enr = await enrollmentState(ctx.db, enrollmentId);
    expect(enr.state).toBe('paused');
    expect(enr.pausedReason).toBe('bounce');

    const result = await processIntent(h.deps, intentId);
    expect(result.kind).toBe('skipped');
    expect(h.providers.get('rep@mock.test')?.deliveredCount ?? 0).toBe(0);
  });
});
