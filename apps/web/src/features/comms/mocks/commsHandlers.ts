import { http, HttpResponse } from 'msw';
import type { Activity, SequenceEnrollment } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import { commsStore, isEmailSuppressed, type OutboxMessage } from '../data/store.ts';

/*
 * Additive MSW handlers for the communication surfaces (S3): templates, snippets,
 * the send path, and the sequences read/enroll/pause endpoints. Shapes follow
 * CONTRACTS §C7 (camelCase, `{error:{code,message,details?}}` per §C8) and the
 * compliance rails from §C6 are enforced HERE, server-side — the API refuses to
 * send to a DNC/suppressed recipient (422 SUPPRESSED, never an override), so a UI
 * that skipped the client-side guard still cannot bypass the rail (I-RAIL-API).
 *
 * Registered like the other feature handler arrays: `server.use(...commsHandlers)`
 * in tests, and spread into the worker/server handler list at merge (routeWiring).
 * Mutations write the module-scope `commsStore`; the send/enroll/pause paths also
 * append the matching C4 activity to the shared timeline `db` (the runtime-write
 * pattern the W1 POST handlers already use for db.smartViews), so the lead page's
 * timeline visibly grows.
 */

const api = (path: string): string => `*/api/v1${path}`;

function errorJson(status: number, code: string, message: string, details?: unknown) {
  const body =
    details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  return HttpResponse.json(body, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

const UNRESOLVED_TAG_RE = /\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/;

/** Append a C4 activity to the shared timeline store (newest-first, like W1). */
function appendActivity(input: {
  leadId: string;
  contactId?: string | null;
  userId?: string | null;
  type: string;
  payload: Record<string, unknown>;
}): Activity {
  const now = new Date().toISOString();
  const activity: Activity = {
    id: crypto.randomUUID(),
    leadId: input.leadId,
    contactId: input.contactId ?? null,
    userId: input.userId ?? null,
    type: input.type,
    occurredAt: now,
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
  };
  const existing = db.activitiesByLead.get(input.leadId);
  if (existing) existing.unshift(activity);
  else db.activitiesByLead.set(input.leadId, [activity]);
  return activity;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export const commsHandlers = [
  // ── Templates + snippets (composer library) ────────────────────────────────
  http.get(api('/templates'), () => HttpResponse.json(commsStore.templates)),
  http.get(api('/snippets'), () => HttpResponse.json(commsStore.snippets)),

  // ── Suppressed recipients for a lead (rep-facing rail signal) ──────────────
  // Minimal, lead-scoped read: which of this lead's contact emails are globally
  // suppressed (unsubscribe/bounce), so the composer can show the DNC rail
  // BEFORE a send is attempted. (Full suppression admin lives under /admin/*.)
  http.get(api('/emails/suppressed-recipients'), ({ request }) => {
    const leadId = new URL(request.url).searchParams.get('leadId');
    if (!leadId) return errorJson(400, 'VALIDATION_FAILED', 'Query "leadId" is required');
    const emails = new Set<string>();
    for (const contact of db.contacts) {
      if (contact.leadId !== leadId || contact.deletedAt !== null) continue;
      for (const entry of contact.emails) {
        if (isEmailSuppressed(entry.email)) emails.add(entry.email.toLowerCase());
      }
    }
    return HttpResponse.json({ emails: [...emails] });
  }),

  // ── Send path (one-off + composer) ─────────────────────────────────────────
  http.post(api('/emails/send'), async ({ request }) => {
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');
    const leadId = typeof body.leadId === 'string' ? body.leadId : null;
    const contactId = typeof body.contactId === 'string' ? body.contactId : null;
    const subject = typeof body.subject === 'string' ? body.subject : '';
    const text = typeof body.body === 'string' ? body.body : '';
    const to = toStringArray(body.to);
    if (!leadId) return errorJson(400, 'VALIDATION_FAILED', 'leadId is required');
    if (to.length === 0)
      return errorJson(400, 'VALIDATION_FAILED', 'At least one recipient is required');
    if (subject.trim() === '') return errorJson(400, 'VALIDATION_FAILED', 'Subject is required');

    // Backstop: the API refuses to ship an unresolved merge tag (mirrors 2d).
    if (UNRESOLVED_TAG_RE.test(subject) || UNRESOLVED_TAG_RE.test(text)) {
      return errorJson(400, 'VALIDATION_FAILED', 'Unresolved merge tags remain in the message');
    }

    // Compliance rail (I-DNC / I-SEND-3): DNC lead/contact or suppressed address
    // → 422 SUPPRESSED. Not an override prompt.
    const lead = db.leads.find((l) => l.id === leadId);
    const contact = contactId ? db.contacts.find((c) => c.id === contactId) : undefined;
    const blocked: Array<{ email: string; reason: 'dnc' | 'suppressed' }> = [];
    for (const email of to) {
      if (lead?.dnc || contact?.dnc) blocked.push({ email, reason: 'dnc' });
      else if (isEmailSuppressed(email)) blocked.push({ email, reason: 'suppressed' });
    }
    if (blocked.length > 0) {
      return errorJson(422, 'SUPPRESSED', 'Recipient is on the do-not-contact list', { blocked });
    }

    const now = new Date().toISOString();
    const message: OutboxMessage = {
      id: crypto.randomUUID(),
      threadId: crypto.randomUUID(),
      leadId,
      contactId,
      to,
      subject,
      body: text,
      sentAt: now,
    };
    commsStore.outbox.unshift(message);
    appendActivity({
      leadId,
      contactId,
      userId: lead?.ownerId ?? null,
      type: 'email_sent',
      payload: { subject, to },
    });
    return HttpResponse.json({ message }, { status: 201 });
  }),

  // ── Sequences (list + step ladder + enrollments) ───────────────────────────
  http.get(api('/sequences'), () => HttpResponse.json(commsStore.sequences)),

  http.get(api('/sequence-steps'), ({ request }) => {
    const sequenceId = new URL(request.url).searchParams.get('sequenceId');
    const items = commsStore.steps
      .filter((s) => (sequenceId ? s.sequenceId === sequenceId : true))
      .sort((a, b) =>
        a.sequenceId === b.sequenceId
          ? a.sortOrder - b.sortOrder
          : a.sequenceId < b.sequenceId
            ? -1
            : 1,
      );
    return HttpResponse.json(items);
  }),

  http.get(api('/sequence-enrollments'), ({ request }) => {
    const sequenceId = new URL(request.url).searchParams.get('sequenceId');
    const items = commsStore.enrollments.filter((e) =>
      sequenceId ? e.sequenceId === sequenceId : true,
    );
    return HttpResponse.json(items);
  }),

  // Enriched roster (read view-model): enrollment + resolved lead/contact display
  // fields, so the detail page can list who's enrolled without N+1 lookups. Pure
  // SequenceEnrollment stays the shape for the enroll/pause mutations below.
  http.get(api('/sequences/:id/roster'), ({ params }) => {
    const sequenceId = String(params.id);
    const rows = commsStore.enrollments
      .filter((e) => e.sequenceId === sequenceId)
      .map((e) => {
        const lead = db.leads.find((l) => l.id === e.leadId);
        const contact = db.contacts.find((c) => c.id === e.contactId);
        return {
          id: e.id,
          sequenceId: e.sequenceId,
          leadId: e.leadId,
          contactId: e.contactId,
          state: e.state,
          pausedReason: e.pausedReason,
          updatedAt: e.updatedAt,
          leadName: lead?.name ?? 'Unknown lead',
          contactName: contact?.name ?? 'Unknown contact',
          contactEmail: contact?.emails[0]?.email ?? '',
        };
      })
      .sort((a, b) =>
        a.state === b.state ? a.leadName.localeCompare(b.leadName) : a.state === 'active' ? -1 : 1,
      );
    return HttpResponse.json(rows);
  }),

  // ── Enroll (POST /sequences/:id/enroll) ────────────────────────────────────
  http.post(api('/sequences/:id/enroll'), async ({ params, request }) => {
    const sequenceId = String(params.id);
    const sequence = commsStore.sequences.find((s) => s.id === sequenceId);
    if (!sequence) return errorJson(404, 'NOT_FOUND', 'Sequence not found');
    if (sequence.status !== 'active') {
      return errorJson(422, 'VALIDATION_FAILED', 'Cannot enroll into an archived sequence');
    }
    const body = await readJson(request);
    const leadId = body && typeof body.leadId === 'string' ? body.leadId : null;
    const contactId = body && typeof body.contactId === 'string' ? body.contactId : null;
    if (!leadId || !contactId) {
      return errorJson(400, 'VALIDATION_FAILED', 'leadId and contactId are required');
    }
    // DNC contacts/leads may not be enrolled (I-DNC at enrollment time).
    const lead = db.leads.find((l) => l.id === leadId);
    const contact = db.contacts.find((c) => c.id === contactId);
    if (lead?.dnc || contact?.dnc) {
      return errorJson(422, 'SUPPRESSED', 'Contact is on the do-not-contact list');
    }
    // C1 uniqueness: one live enrollment per (sequence, contact).
    const dupe = commsStore.enrollments.find(
      (e) =>
        e.sequenceId === sequenceId &&
        e.contactId === contactId &&
        (e.state === 'active' || e.state === 'paused'),
    );
    if (dupe) return errorJson(409, 'CONFLICT', 'Contact is already enrolled in this sequence');

    const now = new Date().toISOString();
    const enrollment: SequenceEnrollment = {
      id: crypto.randomUUID(),
      sequenceId,
      leadId,
      contactId,
      emailAccountId: null,
      enrolledBy: db.users[0]?.id ?? null,
      state: 'active',
      pausedReason: null,
      createdAt: now,
      updatedAt: now,
    };
    commsStore.enrollments.push(enrollment);
    appendActivity({
      leadId,
      contactId,
      userId: enrollment.enrolledBy,
      type: 'sequence_enrolled',
      payload: { sequence: sequence.name },
    });
    return HttpResponse.json(enrollment, { status: 201 });
  }),

  // ── Pause / resume an enrollment (PATCH) ───────────────────────────────────
  http.patch(api('/sequence-enrollments/:id'), async ({ params, request }) => {
    const enrollment = commsStore.enrollments.find((e) => e.id === String(params.id));
    if (!enrollment) return errorJson(404, 'NOT_FOUND', 'Enrollment not found');
    const body = await readJson(request);
    const nextState = body && typeof body.state === 'string' ? body.state : null;
    if (nextState !== 'active' && nextState !== 'paused') {
      return errorJson(400, 'VALIDATION_FAILED', 'state must be "active" or "paused"');
    }
    const reason = body && typeof body.pausedReason === 'string' ? body.pausedReason : 'manual';
    enrollment.state = nextState;
    enrollment.pausedReason = nextState === 'paused' ? reason : null;
    enrollment.updatedAt = new Date().toISOString();
    if (nextState === 'paused') {
      appendActivity({
        leadId: enrollment.leadId,
        contactId: enrollment.contactId,
        userId: enrollment.enrolledBy,
        type: 'sequence_paused',
        payload: { reason },
      });
    }
    return HttpResponse.json(enrollment);
  }),
];
