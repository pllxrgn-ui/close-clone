import { beforeEach, describe, expect, test } from 'vitest';
import type { Contact, Lead } from '@switchboard/shared';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { callingHandlers, type DialerEntry } from './callingHandlers.ts';
import { findCall, isPhoneSuppressed, resetCallsStore } from '../data/callsStore.ts';

/*
 * Handler-level contract tests for the calling MSW surface. These pin the pieces
 * the components exercise only indirectly: dial resolves the primary phone and
 * arms recording (I-REC → recording_consent_played), the outcome PATCH lands a
 * `call_logged` on the timeline, the sequential dialer is a 409 while a call is
 * live, and every §C8 failure path (400/404/409/422) so a caller that skips the
 * UI still hits the rails (I-RAIL-API). Timeline assertions use before/after
 * deltas since the shared `db.activitiesByLead` map is not reset between tests.
 */

const userId = db.users[0]!.id;

interface Dialable {
  lead: Lead;
  contact: Contact;
  phone: string;
}

/** A non-DNC lead whose primary contact has a phone that is NOT suppressed. */
function findDialable(): Dialable {
  for (const lead of db.leads) {
    if (lead.dnc || lead.deletedAt !== null) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && c.phones.length > 0,
    );
    const phone = contact?.phones[0]?.phone;
    if (contact && phone && !contact.dnc && !isPhoneSuppressed(phone)) {
      return { lead, contact, phone };
    }
  }
  throw new Error('fixture has no dialable lead');
}

function findDncLead(): Lead {
  const lead = db.leads.find((l) => l.dnc && l.deletedAt === null);
  if (!lead) throw new Error('fixture has no DNC lead');
  return lead;
}

/** The lead+phone seeded into the suppression set (a non-DNC lead, phone blocked). */
function findSuppressed(): Dialable {
  for (const lead of db.leads) {
    if (lead.dnc || lead.deletedAt !== null) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && c.phones.length > 0,
    );
    const phone = contact?.phones[0]?.phone;
    if (contact && phone && isPhoneSuppressed(phone)) return { lead, contact, phone };
  }
  throw new Error('no suppressed dialable phone was seeded');
}

/** A non-DNC contact with NO phone (drives the "no destination number" path). */
function findPhonelessContact(): Contact {
  const contact = db.contacts.find((c) => c.deletedAt === null && !c.dnc && c.phones.length === 0);
  if (!contact) throw new Error('fixture has no phoneless contact');
  return contact;
}

function timelineCount(leadId: string, type?: string): number {
  const list = db.activitiesByLead.get(leadId) ?? [];
  return type ? list.filter((a) => a.type === type).length : list.length;
}

function errorCode(json: unknown): string | undefined {
  if (typeof json === 'object' && json !== null && 'error' in json) {
    const err = (json as { error: unknown }).error;
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return String((err as { code: unknown }).code);
    }
  }
  return undefined;
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function patch(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`/api/v1${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeEach(() => {
  resetCallsStore();
  server.use(...callingHandlers);
});

describe('POST /calls/dial', () => {
  test('places a call, resolves the primary phone, and arms recording (I-REC)', async () => {
    const { lead, phone } = findDialable();
    const before = timelineCount(lead.id, 'recording_consent_played');

    const { status, json } = await post('/calls/dial', { userId, leadId: lead.id });

    expect(status).toBe(200);
    expect(json.callId).toEqual(expect.any(String));
    expect(json.callSid).toMatch(/^CA/);
    expect(json.to).toBe(phone);
    expect(json.recording).toBe(true);
    // The call row exists and the consent announcement precedes any recording.
    expect(findCall(json.callId)?.status).toBe('queued');
    expect(timelineCount(lead.id, 'recording_consent_played')).toBe(before + 1);
  });

  test('honors a per-call recording opt-out (no consent event armed)', async () => {
    const { lead } = findDialable();
    const before = timelineCount(lead.id, 'recording_consent_played');
    const { json } = await post('/calls/dial', { userId, leadId: lead.id, recordOptOut: true });
    expect(json.recording).toBe(false);
    expect(timelineCount(lead.id, 'recording_consent_played')).toBe(before);
  });

  test('a DNC lead is a hard 422 SUPPRESSED, never an override (I-DNC)', async () => {
    const lead = findDncLead();
    const { status, json } = await post('/calls/dial', { userId, leadId: lead.id });
    expect(status).toBe(422);
    expect(errorCode(json)).toBe('SUPPRESSED');
  });

  test('a suppressed number is a hard 422 SUPPRESSED even on a non-DNC lead', async () => {
    const { lead } = findSuppressed();
    const { status, json } = await post('/calls/dial', { userId, leadId: lead.id });
    expect(status).toBe(422);
    expect(errorCode(json)).toBe('SUPPRESSED');
  });

  test('an unknown lead is 404', async () => {
    const { status, json } = await post('/calls/dial', {
      userId,
      leadId: '00000000-0000-4000-8000-000000000000',
    });
    expect(status).toBe(404);
    expect(errorCode(json)).toBe('NOT_FOUND');
  });

  test('a contact with no phone yields 400 (no destination number)', async () => {
    const contact = findPhonelessContact();
    const { status, json } = await post('/calls/dial', {
      userId,
      leadId: contact.leadId,
      contactId: contact.id,
    });
    expect(status).toBe(400);
    expect(errorCode(json)).toBe('VALIDATION_FAILED');
  });
});

describe('PATCH /calls/:id', () => {
  test('an outcome finalizes the call and lands a call_logged on the timeline', async () => {
    const { lead } = findDialable();
    const { json: dialed } = await post('/calls/dial', { userId, leadId: lead.id });
    const before = timelineCount(lead.id, 'call_logged');

    const { status, json } = await patch(`/calls/${dialed.callId}`, {
      outcome: 'Connected',
      notes: 'Discussed pricing; sending a recap.',
      actorId: userId,
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ callId: dialed.callId, outcome: 'Connected' });
    expect(json.noteId).toEqual(expect.any(String));
    expect(timelineCount(lead.id, 'call_logged')).toBe(before + 1);
    expect(timelineCount(lead.id, 'note_added')).toBeGreaterThan(0);
    const call = findCall(dialed.callId);
    expect(call?.status).toBe('completed');
    expect(call?.outcome).toBe('Connected');
    expect(call?.endedAt).not.toBeNull();
  });

  test('a "No answer" outcome finalizes to the missed status', async () => {
    const { lead } = findDialable();
    const { json: dialed } = await post('/calls/dial', { userId, leadId: lead.id });
    await patch(`/calls/${dialed.callId}`, { outcome: 'No answer' });
    expect(findCall(dialed.callId)?.status).toBe('missed');
  });

  test('finalizing is idempotent — a second outcome does not double-log', async () => {
    const { lead } = findDialable();
    const { json: dialed } = await post('/calls/dial', { userId, leadId: lead.id });
    await patch(`/calls/${dialed.callId}`, { outcome: 'Connected' });
    const after1 = timelineCount(lead.id, 'call_logged');
    await patch(`/calls/${dialed.callId}`, { outcome: 'Meeting booked' });
    expect(timelineCount(lead.id, 'call_logged')).toBe(after1);
  });

  test('an unknown call id is 404', async () => {
    const { status, json } = await patch('/calls/00000000-0000-4000-8000-000000000000', {
      outcome: 'Connected',
    });
    expect(status).toBe(404);
    expect(errorCode(json)).toBe('NOT_FOUND');
  });
});

describe('POST /calls/dialer/queue', () => {
  test('returns callable-lead entries annotated with the compliance flags', async () => {
    const view = db.smartViews[0]!;
    const { status, json } = await post('/calls/dialer/queue', {
      userId,
      smartViewId: view.id,
      limit: 100,
    });
    expect(status).toBe(200);
    const items = json.items as DialerEntry[];
    expect(items.length).toBeGreaterThan(0);
    for (const entry of items) {
      expect(entry.phone).not.toBeNull();
      expect(entry.dialable).toBe(!entry.dnc && !entry.suppressed);
    }
    // The demo dataset carries both dialable and DNC-blocked rows (rail visible).
    expect(items.some((e) => e.dialable)).toBe(true);
    expect(items.some((e) => e.dnc)).toBe(true);
  });

  test('paginates by keyset cursor', async () => {
    const view = db.smartViews[0]!;
    const first = await post('/calls/dialer/queue', { userId, smartViewId: view.id, limit: 1 });
    expect(first.json.items).toHaveLength(1);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const second = await post('/calls/dialer/queue', {
      userId,
      smartViewId: view.id,
      limit: 1,
      cursor: first.json.nextCursor,
    });
    expect(second.json.items).toHaveLength(1);
    expect(second.json.items[0].leadId).not.toBe(first.json.items[0].leadId);
  });

  test('missing query source is 400', async () => {
    const { status, json } = await post('/calls/dialer/queue', { userId });
    expect(status).toBe(400);
    expect(errorCode(json)).toBe('VALIDATION_FAILED');
  });

  test('an unknown smartViewId is 404', async () => {
    const { status, json } = await post('/calls/dialer/queue', {
      userId,
      smartViewId: '00000000-0000-4000-8000-000000000000',
    });
    expect(status).toBe(404);
    expect(errorCode(json)).toBe('NOT_FOUND');
  });
});

describe('POST /calls/dialer/advance', () => {
  test('places the next call when the rep has none live', async () => {
    const { lead, phone } = findDialable();
    const { status, json } = await post('/calls/dialer/advance', { userId, leadId: lead.id });
    expect(status).toBe(200);
    expect(json.to).toBe(phone);
  });

  test('a live call blocks the advance with 409 CONFLICT (sequential only)', async () => {
    const first = findDialable();
    await post('/calls/dial', { userId, leadId: first.lead.id }); // now live (queued)
    const { status, json } = await post('/calls/dialer/advance', {
      userId,
      leadId: first.lead.id,
    });
    expect(status).toBe(409);
    expect(errorCode(json)).toBe('CONFLICT');
  });
});

describe('POST /calls/:id/voicemail-drop', () => {
  test('drops an asset, finalizes to voicemail, and logs the call', async () => {
    const { lead } = findDialable();
    const { json: dialed } = await post('/calls/dial', { userId, leadId: lead.id });
    const before = timelineCount(lead.id, 'call_logged');

    const { status, json } = await post(`/calls/${dialed.callId}/voicemail-drop`, {
      recordingRef: 'vm-intro-first-touch',
      actorId: userId,
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ callId: dialed.callId, activity: 'call_logged' });
    expect(findCall(dialed.callId)?.status).toBe('voicemail');
    expect(findCall(dialed.callId)?.outcome).toBe('voicemail_drop');
    expect(timelineCount(lead.id, 'call_logged')).toBe(before + 1);
  });

  test('a drop with no recordingRef is 400', async () => {
    const { lead } = findDialable();
    const { json: dialed } = await post('/calls/dial', { userId, leadId: lead.id });
    const { status, json } = await post(`/calls/${dialed.callId}/voicemail-drop`, {});
    expect(status).toBe(400);
    expect(errorCode(json)).toBe('VALIDATION_FAILED');
  });

  test('a drop on an already-finalized call is 409 CONFLICT', async () => {
    const { lead } = findDialable();
    const { json: dialed } = await post('/calls/dial', { userId, leadId: lead.id });
    await patch(`/calls/${dialed.callId}`, { outcome: 'Connected' }); // finalized
    const { status, json } = await post(`/calls/${dialed.callId}/voicemail-drop`, {
      recordingRef: 'vm-intro-first-touch',
    });
    expect(status).toBe(409);
    expect(errorCode(json)).toBe('CONFLICT');
  });

  test('a drop on an unknown call is 404', async () => {
    const { status, json } = await post('/calls/00000000-0000-4000-8000-000000000000/voicemail-drop', {
      recordingRef: 'vm-intro-first-touch',
    });
    expect(status).toBe(404);
    expect(errorCode(json)).toBe('NOT_FOUND');
  });
});
