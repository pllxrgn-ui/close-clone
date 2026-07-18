import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Lead } from '@switchboard/shared';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { ApiError } from '../../../api/index.ts';
import { listSmsThread, sendSms } from '../api/sms.ts';
import { messagesForLead, resetSmsStore, smsStore } from '../data/store.ts';
import { smsHandlers } from './smsHandlers.ts';
import { isInboundOptOut } from '../lib/sms.ts';

/*
 * The SMS store + MSW handler contract, exercised against the SHARED server so the
 * cooperative `/sms/send` shadowing with the inbox handler is real. These pin the
 * send rails (I-DNC/suppression, I-QUIET), the §4.5 first-contact opt-out append,
 * idempotency, and the timeline fan-out — the behaviours the composer relies on.
 */

const REP = (): string => {
  const id = db.users[0]?.id;
  if (!id) throw new Error('fixture has no users');
  return id;
};

/** A non-DNC lead with a seeded, sendable outbound thread. */
function primaryLead(): { lead: Lead; contactId: string } {
  const first = smsStore.messages.find(
    (m) => m.direction === 'outbound' && !isInboundOptOut(m.body),
  );
  const lead = db.leads.find((l) => l.id === first?.leadId);
  if (!lead || !first?.contactId) throw new Error('no seeded sendable lead');
  return { lead, contactId: first.contactId };
}

function dncLead(): Lead {
  const lead = db.leads.find((l) => l.dnc && l.deletedAt === null);
  if (!lead) throw new Error('fixture has no DNC lead');
  return lead;
}

/** The lead whose thread contains an inbound STOP (opted-out number). */
function optedOutLead(): { leadId: string; toNumber: string } {
  const stop = smsStore.messages.find((m) => m.direction === 'inbound' && isInboundOptOut(m.body));
  if (!stop) throw new Error('no opted-out thread seeded');
  return { leadId: stop.leadId, toNumber: stop.fromNumber };
}

beforeEach(() => {
  resetSmsStore();
  server.use(...smsHandlers);
});
afterEach(() => {
  resetSmsStore();
});

describe('GET /leads/:id/sms', () => {
  test('returns the seeded conversation with inbound and outbound rows', async () => {
    const { lead } = primaryLead();
    const items = await listSmsThread(lead.id);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((m) => m.direction === 'inbound')).toBe(true);
    expect(items.some((m) => m.direction === 'outbound')).toBe(true);
    // Chronological (oldest → newest).
    const times = items.map((m) => m.sentAt ?? m.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  test('404s for an unknown lead', async () => {
    await expect(listSmsThread('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('POST /sms/send — success + timeline fan-out', () => {
  test('appends an outbound bubble and an sms_sent activity to the lead timeline', async () => {
    const { lead, contactId } = primaryLead();
    const before = messagesForLead(lead.id).length;
    const activitiesBefore = db.activitiesByLead.get(lead.id)?.length ?? 0;

    const result = await sendSms({
      userId: REP(),
      leadId: lead.id,
      contactId,
      body: 'Following up now',
    });

    expect(result.deduped).toBe(false);
    expect(result.smsMessageId).toBeTruthy();
    expect(messagesForLead(lead.id).length).toBe(before + 1);

    const activities = db.activitiesByLead.get(lead.id) ?? [];
    expect(activities.length).toBe(activitiesBefore + 1);
    expect(activities[0]?.type).toBe('sms_sent'); // newest-first
    expect(activities[0]?.payload.smsMessageId).toBe(result.smsMessageId);
  });

  test('appends first-contact opt-out language to a fresh number, not to a repeat', async () => {
    const { lead, contactId } = primaryLead();
    const fresh = '+13125557000';

    const first = await sendSms({
      userId: REP(),
      leadId: lead.id,
      contactId,
      to: fresh,
      body: 'Hi there',
    });
    expect(first.optOutLanguageAppended).toBe(true);
    expect(first.body).toMatch(/Reply STOP to unsubscribe\.$/);

    const second = await sendSms({
      userId: REP(),
      leadId: lead.id,
      contactId,
      to: fresh,
      body: 'Second note',
    });
    expect(second.optOutLanguageAppended).toBe(false);
    expect(second.body).toBe('Second note');
  });

  test('does not append opt-out language when the body already carries it', async () => {
    const { lead, contactId } = primaryLead();
    const result = await sendSms({
      userId: REP(),
      leadId: lead.id,
      contactId,
      to: '+13125557001',
      body: 'Ping — reply STOP to opt out.',
    });
    expect(result.optOutLanguageAppended).toBe(false);
  });
});

describe('POST /sms/send — compliance rails (I-RAIL-API)', () => {
  test('blocks a DNC lead with C8 SUPPRESSED (422)', async () => {
    const lead = dncLead();
    await expect(
      sendSms({ userId: REP(), leadId: lead.id, to: '+12065550111', body: 'hi' }),
    ).rejects.toMatchObject({
      code: 'SUPPRESSED',
      status: 422,
    });
  });

  test('blocks an opted-out (STOP) number with C8 SUPPRESSED (422)', async () => {
    const { leadId, toNumber } = optedOutLead();
    await expect(
      sendSms({ userId: REP(), leadId, to: toNumber, body: 'still there?' }),
    ).rejects.toMatchObject({
      code: 'SUPPRESSED',
    });
  });

  test('blocks a send outside quiet hours with C8 OUTSIDE_WINDOW (422)', async () => {
    const { lead, contactId } = primaryLead();
    smsStore.clock = () => new Date('2026-07-15T06:00:00.000Z'); // 11pm Pacific
    await expect(
      sendSms({ userId: REP(), leadId: lead.id, contactId, body: 'late night' }),
    ).rejects.toMatchObject({
      code: 'OUTSIDE_WINDOW',
      status: 422,
    });
  });
});

describe('POST /sms/send — idempotency + validation', () => {
  test('a repeated idempotency key is a deduped no-op', async () => {
    const { lead, contactId } = primaryLead();
    const before = messagesForLead(lead.id).length;
    const key = 'idem-123';

    const first = await sendSms({
      userId: REP(),
      leadId: lead.id,
      contactId,
      body: 'once',
      idempotencyKey: key,
    });
    const second = await sendSms({
      userId: REP(),
      leadId: lead.id,
      contactId,
      body: 'once',
      idempotencyKey: key,
    });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.smsMessageId).toBe(first.smsMessageId);
    expect(messagesForLead(lead.id).length).toBe(before + 1);
  });

  test('rejects an empty body and an unknown contact', async () => {
    const { lead } = primaryLead();
    await expect(sendSms({ userId: REP(), leadId: lead.id, body: '   ' })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(
      sendSms({
        userId: REP(),
        leadId: lead.id,
        contactId: '00000000-0000-0000-0000-000000000000',
        body: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
