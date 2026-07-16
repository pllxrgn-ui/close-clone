import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  contacts,
  leads,
  orgSettings,
  sendIntents,
  smsMessages,
  suppressions,
  type Db,
} from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { enrollContacts } from './enrollment.ts';
import { processIntent, type DispatchDeps, type DispatchResult } from './dispatch.ts';
import { pauseOnInboundReply } from './pause.ts';
import {
  activityTypes,
  countActivities,
  intentState,
  intentsForEnrollment,
  makeHarness,
  seedContact,
  seedLead,
  seedSequence,
  seedSmsTemplate,
  seedUser,
  setOrgSettings,
  type EngineHarness,
} from './test-helpers.ts';

/**
 * SMS-in-sequences adversarial suite (S1, CONTRACTS §C6 I-QUIET / I-DNC). Mirrors
 * the email `send-safety.property.test.ts` for the telephony channel: the SMS step
 * runs the SAME claim → recheck → send-outside-txn → phase-C re-lock discipline, so
 * an opt-out / DNC-flip / quiet-hours boundary / reply arriving BETWEEN scheduling
 * and send can never yield a SENT, and N racing workers make ≤1 provider call.
 *
 * PGlite serializes transactions (single embedded connection), so concurrent
 * `Promise.all` submissions exercise real Postgres serialization semantics over the
 * SQL-level guards (the `WHERE state='SCHEDULED'` claim + `FOR UPDATE` enrollment
 * lock). Deterministic: injected clock + counted mock provider, no wall-clock/random.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// A unique NANP-shaped number per scenario. Area code 555 is unmapped, so I-QUIET
// falls back to the company tz (UTC). Uniqueness matters: phone suppressions are
// GLOBAL by trailing-10 key, so a shared number would leak a STOP across scenarios.
function scenarioPhone(n: number): { phone: string; key: string } {
  const line = String(1000 + (n % 9000)).padStart(4, '0');
  const phone = `+1555555${line}`; // +1 555 555 XXXX
  return { phone, key: `555555${line}` };
}

let ctx: TestDb;
let h: EngineHarness;
let uniq = 0;

interface SmsScenario {
  enrollmentId: string;
  intentId: string;
  leadId: string;
  contactId: string;
  phone: string;
  phoneKey: string;
}

/** A one-SMS-step sequence enrolled for a fresh (lead, contact-with-phone). */
async function freshSmsScenario(
  opts: { delayHours?: number; requiresReview?: boolean; body?: string } = {},
): Promise<SmsScenario> {
  uniq += 1;
  const { phone, key } = scenarioPhone(uniq);
  const rep = await seedUser(ctx.db, `smsrep-${uniq}@switchboard.test`);
  const leadId = await seedLead(ctx.db, `SmsAcme ${uniq}`);
  const contactId = await seedContact(ctx.db, leadId, `dana-${uniq}@acme.test`, {
    name: 'Dana',
    phone,
  });
  const template = await seedSmsTemplate(
    ctx.db,
    rep,
    opts.body !== undefined ? { body: opts.body } : {},
  );
  const { sequenceId } = await seedSequence(ctx.db, [
    {
      type: 'sms',
      delayHours: opts.delayHours ?? 0,
      templateId: template,
      ...(opts.requiresReview === true ? { requiresReview: true } : {}),
    },
  ]);
  const res = await enrollContacts(h.deps, {
    sequenceId,
    enrolledBy: rep,
    targets: [{ leadId, contactId }],
  });
  const enrollmentId = res.enrolled[0]!.enrollmentId;
  const intentId = (await intentsForEnrollment(ctx.db, enrollmentId))[0]!.id;
  return { enrollmentId, intentId, leadId, contactId, phone, phoneKey: key };
}

function asWorker(workerId: string): DispatchDeps {
  return { ...h.deps, workerId };
}

async function pauseReply(leadId: string): Promise<void> {
  await ctx.db.transaction(async (txRaw) => {
    await pauseOnInboundReply(txRaw as Db, leadId);
  });
}

async function sentIntentCount(enrollmentId: string): Promise<number> {
  const rows = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(sendIntents)
    .where(and(eq(sendIntents.enrollmentId, enrollmentId), eq(sendIntents.state, 'SENT')));
  return Number(rows[0]!.n);
}

async function outboundSmsCount(leadId: string): Promise<number> {
  const rows = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(smsMessages)
    .where(and(eq(smsMessages.leadId, leadId), eq(smsMessages.direction, 'outbound')));
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  ctx = await createTestDb();
  h = makeHarness(ctx.db);
  await setOrgSettings(ctx.db, { dailySendCap: 200, companyTimezone: 'UTC' });
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(() => {
  h.clock.now = new Date('2026-03-02T15:00:00.000Z'); // Monday 15:00 UTC — inside 8–21
  h.telephony.setSmsSendInterceptor(undefined);
});

describe('happy path — an SMS step actually sends via the telephony provider', () => {
  test('marks SENT, persists one outbound sms_messages row, emits sequence_step_sent once', async () => {
    const sc = await freshSmsScenario();
    const before = h.telephony.sendSmsCount;

    const res = await processIntent(h.deps, sc.intentId);
    expect(res.kind).toBe('sent');
    expect(res.providerMessageId).toBeDefined();

    expect((await intentState(ctx.db, sc.intentId)).state).toBe('SENT');
    expect(h.telephony.sendSmsCount).toBe(before + 1);
    expect(await outboundSmsCount(sc.leadId)).toBe(1);
    // The sequence timeline records the send exactly once (channel-tagged sms).
    expect(await countActivities(ctx.db, sc.leadId, 'sequence_step_sent')).toBe(1);
    expect(await countActivities(ctx.db, sc.leadId, 'sequence_finished')).toBe(1);
    const types = await activityTypes(ctx.db, sc.leadId);
    expect(types).toContain('sequence_step_sent');
  });

  test('first-contact opt-out language (§4.5) is appended to the first outbound body', async () => {
    const sc = await freshSmsScenario({ body: 'Following up on our chat.' });
    await processIntent(h.deps, sc.intentId);
    const rows = await ctx.db
      .select({ body: smsMessages.body })
      .from(smsMessages)
      .where(eq(smsMessages.leadId, sc.leadId));
    expect(rows[0]!.body).toMatch(/STOP/i);
  });

  test('idempotent: a second processIntent is a no-op; provider called once for the key', async () => {
    const sc = await freshSmsScenario();
    expect((await processIntent(h.deps, sc.intentId)).kind).toBe('sent');
    expect((await processIntent(h.deps, sc.intentId)).kind).toBe('not_claimed');
    expect(h.telephony.sendSmsCountForKey(sc.intentId)).toBe(1);
    expect(await sentIntentCount(sc.enrollmentId)).toBe(1);
  });
});

describe('I-SEND-1: N workers race one SMS claim → ≤1 provider call, exactly one SENT', () => {
  test('exactly one worker sends', async () => {
    for (let s = 0; s < 6; s += 1) {
      const sc = await freshSmsScenario();
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          processIntent(asWorker(`smsw-${s}-${i}`), sc.intentId),
        ),
      );
      expect(
        results.filter((r) => r.status === 'rejected'),
        `seed ${s}`,
      ).toHaveLength(0);
      const kinds = results.map((r) => (r as PromiseFulfilledResult<DispatchResult>).value.kind);
      expect(
        kinds.filter((k) => k === 'sent'),
        `seed ${s}: one sent`,
      ).toHaveLength(1);
      // ≤1 provider call for this intent key; exactly one SENT row + one sms_messages row.
      expect(h.telephony.sendSmsCountForKey(sc.intentId)).toBeLessThanOrEqual(1);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(1);
      expect(await outboundSmsCount(sc.leadId)).toBe(1);
    }
  });
});

describe('I-QUIET: an opt-out/DNC/quiet-hours change BETWEEN schedule and send → never SENT', () => {
  test('STOP opt-out (phone suppression) committed before the claim → BLOCKED, provider untouched', async () => {
    for (let s = 0; s < 6; s += 1) {
      const sc = await freshSmsScenario();
      const before = h.telephony.sendSmsCount;
      // A STOP inbound raises a global (kind='phone') suppression on the number.
      await ctx.db
        .insert(suppressions)
        .values({ kind: 'phone', value: sc.phoneKey, source: 'stop_keyword' });

      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind, `seed ${s}`).toBe('blocked');
      expect((await intentState(ctx.db, sc.intentId)).skipReason).toBe('suppressed');
      expect(h.telephony.sendSmsCount).toBe(before);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
      expect(await outboundSmsCount(sc.leadId)).toBe(0);
    }
  });

  test('lead / contact DNC flipped before the claim → BLOCKED, never SENT', async () => {
    for (const scope of ['lead', 'contact'] as const) {
      const sc = await freshSmsScenario();
      const before = h.telephony.sendSmsCount;
      if (scope === 'lead') {
        await ctx.db.update(leads).set({ dnc: true }).where(eq(leads.id, sc.leadId));
      } else {
        await ctx.db.update(contacts).set({ dnc: true }).where(eq(contacts.id, sc.contactId));
      }
      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind, scope).toBe('blocked');
      expect((await intentState(ctx.db, sc.intentId)).skipReason).toBe(`${scope}_dnc`);
      expect(h.telephony.sendSmsCount).toBe(before);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
    }
  });

  test('outside the 8am–9pm window → DEFERRED, provider untouched (never sent in quiet hours)', async () => {
    const sc = await freshSmsScenario();
    const before = h.telephony.sendSmsCount;
    // Narrow the allowed window so 15:00 UTC is outside it (recipient tz → company UTC).
    await ctx.db
      .update(orgSettings)
      .set({ quietHours: { start: '08:00', end: '09:00', timezone: 'UTC' } });
    const res = await processIntent(h.deps, sc.intentId);
    expect(res.kind).toBe('deferred');
    expect(res.reason).toBe('outside_quiet_hours');
    expect(h.telephony.sendSmsCount).toBe(before);
    expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
    // The intent is re-scheduled (not terminal), so it can send once inside the window.
    expect((await intentState(ctx.db, sc.intentId)).state).toBe('SCHEDULED');
    await ctx.db.update(orgSettings).set({ quietHours: null });
  });

  test('opt-out committed while the intent is scheduled in the future → still BLOCKED when due', async () => {
    const sc = await freshSmsScenario({ delayHours: 1 });
    // Not yet due.
    expect((await processIntent(h.deps, sc.intentId)).kind).toBe('not_claimed');
    // STOP lands before the due time.
    await ctx.db
      .insert(suppressions)
      .values({ kind: 'phone', value: sc.phoneKey, source: 'stop_keyword' });
    h.clock.now = new Date('2026-03-02T16:00:01.000Z');
    const res = await processIntent(h.deps, sc.intentId);
    expect(res.kind).toBe('blocked');
    expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
  });
});

describe('races: a rail change concurrent with the claim never over-sends', () => {
  test('STOP-insert raced against the claim → never both suppressed-first and SENT', async () => {
    for (let s = 0; s < 8; s += 1) {
      const sc = await freshSmsScenario();
      const insertSupp = ctx.db
        .insert(suppressions)
        .values({ kind: 'phone', value: sc.phoneKey, source: 'stop_keyword' });
      const [pRes] = await Promise.allSettled([processIntent(h.deps, sc.intentId), insertSupp]);
      expect(pRes.status, `seed ${s}`).toBe('fulfilled');
      // ≤1 provider call; a BLOCKED outcome implies the provider was never called.
      expect(h.telephony.sendSmsCountForKey(sc.intentId)).toBeLessThanOrEqual(1);
      const st = await intentState(ctx.db, sc.intentId);
      expect(['SENT', 'BLOCKED']).toContain(st.state);
      if (st.state === 'BLOCKED') expect(await outboundSmsCount(sc.leadId)).toBe(0);
    }
  });

  test('reply committed BEFORE the claim → SKIPPED at the enrollment-active gate, never SENT', async () => {
    for (let s = 0; s < 6; s += 1) {
      const sc = await freshSmsScenario();
      const before = h.telephony.sendSmsCount;
      await pauseReply(sc.leadId); // reply lands between scheduling and the claim
      const res = await processIntent(h.deps, sc.intentId);
      expect(res.kind, `seed ${s}`).toBe('skipped');
      expect(h.telephony.sendSmsCount).toBe(before);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
      expect(await outboundSmsCount(sc.leadId)).toBe(0);
      expect(await countActivities(ctx.db, sc.leadId, 'sequence_step_sent')).toBe(0);
    }
  });

  test('reply-pause committed DURING provider.sendSms → paused_during_send, never SENT', async () => {
    for (let s = 0; s < 6; s += 1) {
      const sc = await freshSmsScenario();
      // A provider wrapper commits the reply-pause AFTER the claim txn but BEFORE the
      // sid returns — the exact phase-C seam. The SMS physically left (one provider
      // call), yet the enrollment re-lock refuses the SENT transition.
      const deps: DispatchDeps = {
        ...h.deps,
        sms: {
          ...h.deps.sms,
          provider: {
            async sendSms(from, to, body, key) {
              await pauseReply(sc.leadId);
              return h.telephony.sendSms(from, to, body, key);
            },
          },
        },
      };
      const res = await processIntent(deps, sc.intentId);
      expect(res.kind, `seed ${s}`).toBe('paused_during_send');
      const st = await intentState(ctx.db, sc.intentId);
      expect(st.state).toBe('SKIPPED');
      expect(st.skipReason).toBe('paused_during_send');
      // Provider was called once, but no SENT row / sms_messages / step-sent event.
      expect(h.telephony.sendSmsCountForKey(sc.intentId)).toBe(1);
      expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
      expect(await outboundSmsCount(sc.leadId)).toBe(0);
      expect(await countActivities(ctx.db, sc.leadId, 'sequence_step_sent')).toBe(0);
    }
  });
});

describe('requires_review: an SMS step gated for review never auto-sends', () => {
  test('N workers racing a review-gated SMS intent never claim or send it', async () => {
    const sc = await freshSmsScenario({ requiresReview: true });
    const before = h.telephony.sendSmsCount;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => processIntent(asWorker(`rvw-${i}`), sc.intentId)),
    );
    const kinds = results.map((r) => (r as PromiseFulfilledResult<DispatchResult>).value.kind);
    expect(kinds.every((k) => k === 'not_claimed')).toBe(true);
    expect((await intentState(ctx.db, sc.intentId)).state).toBe('AWAITING_REVIEW');
    expect(h.telephony.sendSmsCount).toBe(before);
    expect(await sentIntentCount(sc.enrollmentId)).toBe(0);
  });
});
