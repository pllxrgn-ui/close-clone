import { beforeEach, describe, expect, test } from 'vitest';
import type { Contact, Lead } from '@switchboard/shared';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { commsHandlers } from './commsHandlers.ts';
import { commsStore, enrollmentCounts, isEmailSuppressed, resetCommsStore } from '../data/store.ts';

/*
 * Handler-level contract tests for the comms MSW surface. These pin the parts the
 * component tests exercise only indirectly: that a send/enroll/pause writes the
 * matching C4 activity into the shared timeline store ("the timeline visibly
 * grows"), that mutations tick the counts, and — critically — the failure paths
 * (§C8 codes: 400/404/409/422) so a caller that skips the UI still hits the rails
 * (I-RAIL-API). Assertions on the shared `db.activitiesByLead` use before/after
 * deltas since that fixture map is not reset between tests.
 */

async function send(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch('/api/v1/emails/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function enroll(seqId: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`/api/v1/sequences/${seqId}/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function patchEnrollment(
  id: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`/api/v1/sequence-enrollments/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
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

/** First sendable (lead, contact): live, non-DNC, has an unsuppressed email. */
function pickSendable(): { lead: Lead; contact: Contact; email: string } {
  for (const contact of db.contacts) {
    if (contact.deletedAt !== null || contact.dnc || contact.emails.length === 0) continue;
    const email = contact.emails[0]?.email;
    if (!email || isEmailSuppressed(email)) continue;
    const lead = db.leads.find((l) => l.id === contact.leadId);
    if (!lead || lead.dnc) continue;
    return { lead, contact, email };
  }
  throw new Error('fixture has no sendable contact');
}

function activeSequenceId(): string {
  const seq = commsStore.sequences.find((s) => s.status === 'active');
  if (!seq) throw new Error('fixture has no active sequence');
  return seq.id;
}

/** A (lead, contact) not yet enrolled in `seqId`, live and non-DNC. */
function pickEnrollable(seqId: string): { lead: Lead; contact: Contact } {
  const enrolled = new Set(
    commsStore.enrollments
      .filter((e) => e.sequenceId === seqId && (e.state === 'active' || e.state === 'paused'))
      .map((e) => e.contactId),
  );
  for (const contact of db.contacts) {
    if (contact.deletedAt !== null || contact.dnc || enrolled.has(contact.id)) continue;
    const lead = db.leads.find((l) => l.id === contact.leadId);
    if (!lead || lead.dnc) continue;
    return { lead, contact };
  }
  throw new Error('fixture has no enrollable contact');
}

function pickDncLeadWithContact(): { lead: Lead; contact: Contact } {
  for (const lead of db.leads) {
    if (!lead.dnc) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && c.emails.length > 0,
    );
    if (contact) return { lead, contact };
  }
  throw new Error('fixture has no DNC lead with a contact');
}

beforeEach(() => {
  resetCommsStore();
  server.use(...commsHandlers);
});

describe('POST /emails/send', () => {
  test('appends to the outbox AND emits an email_sent activity into the timeline', async () => {
    const { lead, contact, email } = pickSendable();
    const outboxBefore = commsStore.outbox.length;
    const timelineBefore = timelineCount(lead.id, 'email_sent');

    const { status, json } = await send({
      leadId: lead.id,
      contactId: contact.id,
      to: [email],
      subject: 'Quick note',
      body: 'Hello there.',
    });

    expect(status).toBe(201);
    expect(commsStore.outbox.length).toBe(outboxBefore + 1);
    expect(commsStore.outbox[0]?.subject).toBe('Quick note');
    // The lead's timeline visibly grew by exactly one email_sent event.
    expect(timelineCount(lead.id, 'email_sent')).toBe(timelineBefore + 1);
    expect(json).toMatchObject({ message: { leadId: lead.id, subject: 'Quick note' } });
  });

  test('a suppressed recipient is refused (422 SUPPRESSED) with no side effects', async () => {
    const email = [...commsStore.suppressedEmails][0];
    expect(email).toBeTruthy();
    const contact = db.contacts.find((c) => c.emails.some((e) => e.email.toLowerCase() === email));
    const leadId = contact?.leadId ?? db.leads[0]?.id ?? '';
    const outboxBefore = commsStore.outbox.length;
    const timelineBefore = timelineCount(leadId, 'email_sent');

    const { status, json } = await send({
      leadId,
      contactId: contact?.id ?? null,
      to: [email],
      subject: 'Hi',
      body: 'Hi',
    });

    expect(status).toBe(422);
    expect(errorCode(json)).toBe('SUPPRESSED');
    expect(commsStore.outbox.length).toBe(outboxBefore); // no send
    expect(timelineCount(leadId, 'email_sent')).toBe(timelineBefore); // no activity
  });

  test('a DNC lead is refused (422 SUPPRESSED)', async () => {
    const { lead, contact } = pickDncLeadWithContact();
    const { status, json } = await send({
      leadId: lead.id,
      contactId: contact.id,
      to: [contact.emails[0]?.email ?? 'x@example.com'],
      subject: 'Hi',
      body: 'Hi',
    });
    expect(status).toBe(422);
    expect(errorCode(json)).toBe('SUPPRESSED');
  });

  test('an unresolved merge tag is refused (400) — the API will not ship {{…}}', async () => {
    const { lead, contact, email } = pickSendable();
    const { status, json } = await send({
      leadId: lead.id,
      contactId: contact.id,
      to: [email],
      subject: 'Hi {{lead.name}}',
      body: 'Body',
    });
    expect(status).toBe(400);
    expect(errorCode(json)).toBe('VALIDATION_FAILED');
  });

  test.each([
    ['missing leadId', { to: ['a@b.com'], subject: 'Hi', body: 'Hi' }],
    ['no recipients', { leadId: 'L1', to: [], subject: 'Hi', body: 'Hi' }],
    ['empty subject', { leadId: 'L1', to: ['a@b.com'], subject: '   ', body: 'Hi' }],
  ])('rejects a malformed send (%s) with 400', async (_label, body) => {
    const { status, json } = await send(body);
    expect(status).toBe(400);
    expect(errorCode(json)).toBe('VALIDATION_FAILED');
  });
});

describe('POST /sequences/:id/enroll (bulk targets, real shape)', () => {
  test('adds an enrollment, ticks the active count, and emits sequence_enrolled', async () => {
    const seqId = activeSequenceId();
    const { lead, contact } = pickEnrollable(seqId);
    const activeBefore = enrollmentCounts(seqId).active;
    const timelineBefore = timelineCount(lead.id, 'sequence_enrolled');

    const { status, json } = await enroll(seqId, {
      targets: [{ leadId: lead.id, contactId: contact.id }],
    });

    expect(status).toBe(200);
    expect((json as { enrolled: unknown[] }).enrolled).toHaveLength(1);
    expect((json as { skipped: unknown[] }).skipped).toHaveLength(0);
    expect(enrollmentCounts(seqId).active).toBe(activeBefore + 1);
    expect(timelineCount(lead.id, 'sequence_enrolled')).toBe(timelineBefore + 1);
  });

  test('a duplicate active enrollment is reported under skipped (not an HTTP error)', async () => {
    const existing = commsStore.enrollments.find((e) => e.state === 'active');
    if (!existing) throw new Error('fixture has no active enrollment');
    const { status, json } = await enroll(existing.sequenceId, {
      targets: [{ leadId: existing.leadId, contactId: existing.contactId }],
    });
    expect(status).toBe(200);
    const body = json as { enrolled: unknown[]; skipped: { reason: string }[] };
    expect(body.enrolled).toHaveLength(0);
    expect(body.skipped[0]?.reason).toBe('already_enrolled');
  });

  test('a DNC contact IS enrolled (the engine blocks at send time, not at enroll)', async () => {
    const seqId = activeSequenceId();
    const dnc = db.contacts.find(
      (c) =>
        c.dnc &&
        c.deletedAt === null &&
        !commsStore.enrollments.some(
          (e) => e.sequenceId === seqId && e.contactId === c.id && e.state !== 'finished',
        ),
    );
    if (!dnc) throw new Error('fixture has no un-enrolled DNC contact');
    const { status, json } = await enroll(seqId, {
      targets: [{ leadId: dnc.leadId, contactId: dnc.id }],
    });
    expect(status).toBe(200);
    expect((json as { enrolled: unknown[] }).enrolled).toHaveLength(1);
  });

  test('an archived sequence cannot take enrollments (422)', async () => {
    const archived = commsStore.sequences.find((s) => s.status === 'archived');
    if (!archived) throw new Error('fixture has no archived sequence');
    const { lead, contact } = pickEnrollable(archived.id);
    const { status } = await enroll(archived.id, {
      targets: [{ leadId: lead.id, contactId: contact.id }],
    });
    expect(status).toBe(422);
  });

  test('enrolling into a missing sequence is 404', async () => {
    const { lead, contact } = pickEnrollable(activeSequenceId());
    const { status, json } = await enroll('00000000-0000-0000-0000-000000000000', {
      targets: [{ leadId: lead.id, contactId: contact.id }],
    });
    expect(status).toBe(404);
    expect(errorCode(json)).toBe('NOT_FOUND');
  });

  test('a malformed target (missing contactId) is 400', async () => {
    const seqId = activeSequenceId();
    const { status, json } = await enroll(seqId, { targets: [{ leadId: 'L1' }] });
    expect(status).toBe(400);
    expect(errorCode(json)).toBe('VALIDATION_FAILED');
  });
});

describe('PATCH /sequence-enrollments/:id (pause / resume)', () => {
  test('pausing sets the reason and emits sequence_paused; resuming clears it silently', async () => {
    const seqId = activeSequenceId();
    const active = commsStore.enrollments.find(
      (e) => e.sequenceId === seqId && e.state === 'active',
    );
    if (!active) throw new Error('fixture has no active enrollment');
    const pausedBefore = enrollmentCounts(seqId).paused;
    const seqPausedBefore = timelineCount(active.leadId, 'sequence_paused');

    const paused = await patchEnrollment(active.id, { state: 'paused', pausedReason: 'manual' });
    expect(paused.status).toBe(200);
    expect(paused.json).toMatchObject({ state: 'paused', pausedReason: 'manual' });
    expect(enrollmentCounts(seqId).paused).toBe(pausedBefore + 1);
    expect(timelineCount(active.leadId, 'sequence_paused')).toBe(seqPausedBefore + 1);

    const resumed = await patchEnrollment(active.id, { state: 'active' });
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({ state: 'active', pausedReason: null });
    // Resuming is not a pause event — no extra sequence_paused was written.
    expect(timelineCount(active.leadId, 'sequence_paused')).toBe(seqPausedBefore + 1);
  });

  test('an unknown enrollment id is 404', async () => {
    const { status, json } = await patchEnrollment('nope', { state: 'paused' });
    expect(status).toBe(404);
    expect(errorCode(json)).toBe('NOT_FOUND');
  });

  test('an invalid target state is 400', async () => {
    const any = commsStore.enrollments[0];
    if (!any) throw new Error('fixture has no enrollment');
    const { status, json } = await patchEnrollment(any.id, { state: 'finished' });
    expect(status).toBe(400);
    expect(errorCode(json)).toBe('VALIDATION_FAILED');
  });
});

describe('GET /emails/suppressed-recipients', () => {
  test('requires a leadId (400 without it)', async () => {
    const res = await fetch('/api/v1/emails/suppressed-recipients');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('VALIDATION_FAILED');
  });
});
