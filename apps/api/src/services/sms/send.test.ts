import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { orgSettings } from '../../db/index.ts';
import {
  createMockTelephonyProvider,
  type MockTelephonyProvider,
} from '../../providers/telephony/index.ts';
import {
  SmsContactNotFoundError,
  SmsLeadNotFoundError,
  SmsProviderError,
  SmsQuietHoursError,
  SmsSuppressedError,
  SmsValidationError,
  sendSms,
  type SmsSendDeps,
} from './send.ts';
import { addPhoneSuppression } from '../telephony/suppression.ts';
import {
  activitiesFor,
  seedContact,
  seedLead,
  seedOrgSettings,
  seedUser,
  smsFor,
} from '../telephony/test-helpers.ts';

/**
 * Outbound SMS engine (task 3f): the ONLY path to `provider.sendSms`, so it owns
 * I-DNC (hard BLOCK, never an override), I-QUIET (8am–9pm recipient-local), and the
 * §4.5 first-contact opt-out language. Every block asserts the provider is NEVER
 * called, and every send asserts exactly one `sms_sent` timeline event.
 */

const REP_NUMBER = '+15617770123';
const EASTERN_NUMBER = '+13055550147'; // NPA 305 → America/New_York
const PACIFIC_NUMBER = '+14155550188'; // NPA 415 → America/Los_Angeles
const NIL = '00000000-0000-4000-8000-0000000000ff';

// Noon Eastern (16:00 UTC in July DST) — inside 8am–9pm for a 305 recipient.
const INSIDE = new Date('2026-07-15T16:00:00.000Z');
// Midnight Eastern (04:00 UTC in July DST) — outside 8am–9pm for a 305 recipient.
const OUTSIDE = new Date('2026-07-15T04:00:00.000Z');

let ctx: TestDb;
let mock: MockTelephonyProvider;
let rep: string;
let lead: string;
let contact: string;

function depsAt(now: Date): SmsSendDeps {
  return { db: ctx.db, provider: mock, now: () => now, fromNumber: REP_NUMBER };
}

async function smsSentCount(leadId: string): Promise<number> {
  return (await activitiesFor(ctx.db, leadId)).filter((a) => a.type === 'sms_sent').length;
}

beforeEach(async () => {
  ctx = await createTestDb();
  mock = createMockTelephonyProvider();
  rep = await seedUser(ctx.db, { name: 'Rep' });
  lead = await seedLead(ctx.db, { name: 'Acme' });
  contact = await seedContact(ctx.db, lead, [EASTERN_NUMBER], { name: 'Dana' });
  await seedOrgSettings(ctx.db, { companyTimezone: 'UTC' });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('happy path', () => {
  test('sends to the contact number and writes one sms row + one sms_sent event', async () => {
    const out = await sendSms(depsAt(INSIDE), {
      userId: rep,
      leadId: lead,
      contactId: contact,
      body: 'Hi Dana, following up.',
    });
    expect(mock.sendSmsCount).toBe(1);
    expect(out.to).toBe(EASTERN_NUMBER);
    expect(out.from).toBe(REP_NUMBER);
    expect(out.providerSid.length).toBeGreaterThan(0);
    expect(out.deduped).toBe(false);

    const rows = await smsFor(ctx.db, lead);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.direction).toBe('outbound');
    expect(rows[0]?.status).toBe('sent');
    expect(await smsSentCount(lead)).toBe(1);
  });

  test('accepts an explicit `to` overriding the contact and works with no contact', async () => {
    const out = await sendSms(depsAt(INSIDE), {
      userId: rep,
      leadId: lead,
      to: EASTERN_NUMBER,
      body: 'Direct number send.',
    });
    expect(out.providerSid.length).toBeGreaterThan(0);
    expect(mock.sendSmsCount).toBe(1);
    expect(await smsSentCount(lead)).toBe(1);
  });
});

describe('I-QUIET — no send outside 8am–9pm recipient-local', () => {
  test('rejects a send outside the recipient-local window; provider not called', async () => {
    await expect(
      sendSms(depsAt(OUTSIDE), { userId: rep, leadId: lead, contactId: contact, body: 'late' }),
    ).rejects.toBeInstanceOf(SmsQuietHoursError);
    expect(mock.sendSmsCount).toBe(0);
    expect(await smsFor(ctx.db, lead)).toHaveLength(0);
    expect(await smsSentCount(lead)).toBe(0);
  });

  test('area-code inference is per-recipient: same instant, Pacific number is inside', async () => {
    // 04:00 UTC = 21:00 (9pm) previous day Pacific → outside; 03:00 UTC = 20:00 inside.
    const pacific = await seedContact(ctx.db, lead, [PACIFIC_NUMBER], { name: 'Pat' });
    const at = new Date('2026-07-15T03:00:00.000Z');
    // Eastern recipient at this instant: 23:00 → outside (rejected).
    await expect(
      sendSms(depsAt(at), { userId: rep, leadId: lead, contactId: contact, body: 'x' }),
    ).rejects.toBeInstanceOf(SmsQuietHoursError);
    // Pacific recipient at the SAME instant: 20:00 → inside (sent).
    const out = await sendSms(depsAt(at), {
      userId: rep,
      leadId: lead,
      contactId: pacific,
      body: 'ok',
    });
    expect(out.providerSid.length).toBeGreaterThan(0);
  });

  test('falls back to company tz when the area code is unmapped', async () => {
    // NPA 999 is not in the map → company tz (set to Pacific here).
    await ctx.db.update(orgSettings).set({ companyTimezone: 'America/Los_Angeles' });
    const nonNanp = await seedContact(ctx.db, lead, ['+19995550100'], { name: 'Uma' });
    // 03:00 UTC → 20:00 Pacific → inside.
    const out = await sendSms(depsAt(new Date('2026-07-15T03:00:00.000Z')), {
      userId: rep,
      leadId: lead,
      contactId: nonNanp,
      body: 'hi',
    });
    expect(out.providerSid.length).toBeGreaterThan(0);
  });
});

describe('I-DNC / suppression — hard block, provider never called', () => {
  test('lead DNC blocks', async () => {
    const dncLead = await seedLead(ctx.db, { name: 'NoContact', dnc: true });
    const c = await seedContact(ctx.db, dncLead, [EASTERN_NUMBER]);
    await expect(
      sendSms(depsAt(INSIDE), { userId: rep, leadId: dncLead, contactId: c, body: 'x' }),
    ).rejects.toMatchObject({ name: 'SmsSuppressedError', reason: 'lead_dnc' });
    expect(mock.sendSmsCount).toBe(0);
  });

  test('contact DNC blocks', async () => {
    const c = await seedContact(ctx.db, lead, [EASTERN_NUMBER], { name: 'No', dnc: true });
    await expect(
      sendSms(depsAt(INSIDE), { userId: rep, leadId: lead, contactId: c, body: 'x' }),
    ).rejects.toMatchObject({ name: 'SmsSuppressedError', reason: 'contact_dnc' });
    expect(mock.sendSmsCount).toBe(0);
  });

  test('an active phone suppression (a prior inbound STOP) blocks the send', async () => {
    // Simulate the 3b ingress having suppressed this number on a STOP inbound.
    await addPhoneSuppression(ctx.db, { key: '3055550147', source: 'stop_keyword' });
    await expect(
      sendSms(depsAt(INSIDE), { userId: rep, leadId: lead, contactId: contact, body: 'x' }),
    ).rejects.toMatchObject({ name: 'SmsSuppressedError', reason: 'phone_suppressed' });
    expect(mock.sendSmsCount).toBe(0);
    expect(await smsSentCount(lead)).toBe(0);
  });

  test('suppression is formatting-insensitive (trailing-10-digit key)', async () => {
    await addPhoneSuppression(ctx.db, { key: '3055550147', source: 'manual' });
    await expect(
      sendSms(depsAt(INSIDE), { userId: rep, leadId: lead, to: '+1 (305) 555-0147', body: 'x' }),
    ).rejects.toBeInstanceOf(SmsSuppressedError);
    expect(mock.sendSmsCount).toBe(0);
  });
});

describe('§4.5 first-contact opt-out language', () => {
  test('appends opt-out language on the first outbound SMS to a number', async () => {
    const out = await sendSms(depsAt(INSIDE), {
      userId: rep,
      leadId: lead,
      contactId: contact,
      body: 'Hello there',
    });
    expect(out.optOutLanguageAppended).toBe(true);
    expect(out.body).toContain('Reply STOP to unsubscribe.');
    const outbound = mock.getOutboundSms();
    expect(outbound[0]?.body).toContain('STOP');
  });

  test('does not re-append on a subsequent message to the same number', async () => {
    await sendSms(depsAt(INSIDE), { userId: rep, leadId: lead, contactId: contact, body: 'first' });
    const second = await sendSms(depsAt(INSIDE), {
      userId: rep,
      leadId: lead,
      contactId: contact,
      body: 'second',
    });
    expect(second.optOutLanguageAppended).toBe(false);
    expect(second.body).toBe('second');
  });

  test('does not append when the rep already wrote STOP language', async () => {
    const out = await sendSms(depsAt(INSIDE), {
      userId: rep,
      leadId: lead,
      contactId: contact,
      body: 'Deals daily. Reply STOP to opt out.',
    });
    expect(out.optOutLanguageAppended).toBe(false);
  });
});

describe('idempotency — same key ⇒ one send, one event', () => {
  test('a repeat with the same idempotency key dedupes (no second row or activity)', async () => {
    const first = await sendSms(depsAt(INSIDE), {
      userId: rep,
      leadId: lead,
      contactId: contact,
      body: 'once',
      idempotencyKey: 'sms-key-1',
    });
    const second = await sendSms(depsAt(INSIDE), {
      userId: rep,
      leadId: lead,
      contactId: contact,
      body: 'once',
      idempotencyKey: 'sms-key-1',
    });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.providerSid).toBe(first.providerSid);
    expect(mock.deliveredSmsCount).toBe(1);
    expect(await smsFor(ctx.db, lead)).toHaveLength(1);
    expect(await smsSentCount(lead)).toBe(1);
  });
});

describe('validation + provider failure', () => {
  test('empty body → SmsValidationError, provider not called', async () => {
    await expect(
      sendSms(depsAt(INSIDE), { userId: rep, leadId: lead, contactId: contact, body: '   ' }),
    ).rejects.toBeInstanceOf(SmsValidationError);
    expect(mock.sendSmsCount).toBe(0);
  });

  test('no destination number → SmsValidationError', async () => {
    const noPhone = await seedLead(ctx.db, { name: 'Empty' });
    await expect(
      sendSms(depsAt(INSIDE), { userId: rep, leadId: noPhone, body: 'x' }),
    ).rejects.toBeInstanceOf(SmsValidationError);
  });

  test('missing lead → SmsLeadNotFoundError', async () => {
    await expect(
      sendSms(depsAt(INSIDE), { userId: rep, leadId: NIL, to: EASTERN_NUMBER, body: 'x' }),
    ).rejects.toBeInstanceOf(SmsLeadNotFoundError);
  });

  test('missing contact → SmsContactNotFoundError', async () => {
    await expect(
      sendSms(depsAt(INSIDE), { userId: rep, leadId: lead, contactId: NIL, body: 'x' }),
    ).rejects.toBeInstanceOf(SmsContactNotFoundError);
  });

  test('contact belonging to another lead → SmsValidationError', async () => {
    const other = await seedLead(ctx.db, { name: 'Other' });
    const otherContact = await seedContact(ctx.db, other, [EASTERN_NUMBER]);
    await expect(
      sendSms(depsAt(INSIDE), { userId: rep, leadId: lead, contactId: otherContact, body: 'x' }),
    ).rejects.toBeInstanceOf(SmsValidationError);
  });

  test('a provider throw becomes SmsProviderError and nothing is persisted', async () => {
    mock.setSmsSendInterceptor(() => {
      throw new Error('twilio 500');
    });
    await expect(
      sendSms(depsAt(INSIDE), { userId: rep, leadId: lead, contactId: contact, body: 'x' }),
    ).rejects.toBeInstanceOf(SmsProviderError);
    expect(await smsFor(ctx.db, lead)).toHaveLength(0);
    expect(await smsSentCount(lead)).toBe(0);
  });
});
