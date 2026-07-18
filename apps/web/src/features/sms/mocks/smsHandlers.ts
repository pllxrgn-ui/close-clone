import { http, HttpResponse } from 'msw';
import type { Activity, SmsMessage } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import {
  appendOptOutLanguage,
  bodyHasOptOutText,
  hasPriorOutbound,
  isWithinQuietWindow,
  timeZoneForNumber,
} from '../lib/sms.ts';
import {
  COMPANY_TIMEZONE,
  ORG_SMS_NUMBER,
  isNumberSuppressed,
  messagesForLead,
  smsStore,
} from '../data/store.ts';

/*
 * Additive MSW handlers for the two-way SMS surface. They match the real routes so
 * MSW is a drop-in for `VITE_API_MODE=real`:
 *
 *   POST /sms/send   — the frozen C7 route (apps/api/src/routes/sms.ts). Enforces
 *                      the SAME rails the engine does, in the same order, so the
 *                      composer's blocked states are exercised for real: I-DNC /
 *                      suppression → C8 SUPPRESSED (422), I-QUIET → OUTSIDE_WINDOW
 *                      (422). On success it appends an outbound sms_messages row AND
 *                      fans an `sms_sent` activity onto the shared lead timeline
 *                      (db.activitiesByLead), mirroring the engine's single-txn write.
 *   GET  /leads/:id/sms — the lead's conversation as `{ items }` C1 SmsMessage rows.
 *                      NOTE (contract friction, reported upward): no C7 GET currently
 *                      returns sms_messages; this is the natural companion route.
 *
 * Register AFTER the core handlers and the inbox handlers (see routeWiring): the
 * inbox owns `POST /sms/send` for inbox-thread replies (requests carrying a
 * `threadId`) and falls through for everything else; this handler defensively passes
 * those through too, so ordering can never make it steal an inbox reply.
 */

const api = (path: string): string => `*/api/v1${path}`;

function errorJson(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Prepend an `sms_sent` activity so the lead timeline (newest-first) reflects the send. */
function recordSmsSentActivity(
  leadId: string,
  contactId: string | null,
  userId: string | null,
  smsMessageId: string,
  body: string,
  occurredAt: string,
): void {
  const activity: Activity = {
    id: crypto.randomUUID(),
    leadId,
    contactId,
    userId,
    type: 'sms_sent',
    occurredAt,
    payload: { smsMessageId, body, channel: 'sms' },
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const existing = db.activitiesByLead.get(leadId);
  if (existing) existing.unshift(activity);
  else db.activitiesByLead.set(leadId, [activity]);
}

export const smsHandlers = [
  // GET /leads/:id/sms — the lead's SMS conversation, chronological (oldest → newest).
  http.get(api('/leads/:id/sms'), ({ params }) => {
    const leadId = String(params.id);
    const lead = db.leads.find((l) => l.id === leadId && l.deletedAt === null);
    if (!lead) return errorJson(404, 'NOT_FOUND', 'Lead not found');
    return HttpResponse.json({ items: messagesForLead(leadId) });
  }),

  // POST /sms/send — the frozen C7 send route (rails enforced identically to the engine).
  http.post(api('/sms/send'), async ({ request }) => {
    const body = await readJson(request.clone());
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'invalid sms send request');

    // Inbox owns thread replies (carry a threadId) — pass those through untouched.
    if (typeof body.threadId === 'string') return undefined;

    const userId = str(body.userId);
    const leadId = str(body.leadId);
    const rawBody = str(body.body);
    if (!userId || !leadId || !rawBody) {
      return errorJson(400, 'VALIDATION_FAILED', 'userId, leadId and body are required');
    }
    const text = rawBody.trim();
    if (text.length === 0) return errorJson(400, 'VALIDATION_FAILED', 'body is required');

    const lead = db.leads.find((l) => l.id === leadId && l.deletedAt === null);
    if (!lead) return errorJson(404, 'NOT_FOUND', `lead ${leadId} not found or soft-deleted`);

    const contactId = str(body.contactId);
    let contact: (typeof db.contacts)[number] | null = null;
    if (contactId !== undefined) {
      contact = db.contacts.find((c) => c.id === contactId && c.deletedAt === null) ?? null;
      if (!contact)
        return errorJson(404, 'NOT_FOUND', `contact ${contactId} not found or soft-deleted`);
      if (contact.leadId !== leadId) {
        return errorJson(
          400,
          'VALIDATION_FAILED',
          `contact ${contactId} does not belong to lead ${leadId}`,
        );
      }
    }

    const toNumber = str(body.to) ?? contact?.phones[0]?.phone;
    if (!toNumber) {
      return errorJson(
        400,
        'VALIDATION_FAILED',
        'no destination number (provide `to` or a contact with a phone)',
      );
    }
    const fromNumber = str(body.from) ?? ORG_SMS_NUMBER;

    // Idempotent retry: a seen key is a no-op that returns the prior send (deduped).
    const headerKey = request.headers.get('idempotency-key') ?? undefined;
    const idempotencyKey =
      str(body.idempotencyKey) ?? (headerKey && headerKey.length > 0 ? headerKey : undefined);
    if (idempotencyKey) {
      const priorId = smsStore.idempotency.get(idempotencyKey);
      if (priorId) {
        const prior = smsStore.messages.find((m) => m.id === priorId);
        if (prior) {
          return HttpResponse.json({
            smsMessageId: prior.id,
            leadId,
            to: prior.toNumber,
            from: prior.fromNumber,
            providerSid: prior.providerSid ?? '',
            body: prior.body,
            optOutLanguageAppended: false,
            deduped: true,
          });
        }
      }
    }

    // Rail 1–3: I-DNC / suppression — a hard block, C8 SUPPRESSED (never an override).
    if (lead.dnc) return errorJson(422, 'SUPPRESSED', 'sms blocked: lead_dnc');
    if (contact?.dnc) return errorJson(422, 'SUPPRESSED', 'sms blocked: contact_dnc');
    if (isNumberSuppressed(toNumber))
      return errorJson(422, 'SUPPRESSED', 'sms blocked: phone_suppressed');

    // Rail 4: I-QUIET — 8am–9pm recipient-local (area-code inferred, fallback company tz).
    const { timeZone } = timeZoneForNumber(toNumber, COMPANY_TIMEZONE);
    if (!isWithinQuietWindow(smsStore.clock(), timeZone)) {
      return errorJson(
        422,
        'OUTSIDE_WINDOW',
        `sms outside quiet-hours window (8am–9pm ${timeZone})`,
      );
    }

    // §4.5 first-contact opt-out language — appended on the first outbound to a number.
    let finalBody = text;
    let optOutLanguageAppended = false;
    if (!hasPriorOutbound(messagesForLead(leadId), toNumber) && !bodyHasOptOutText(text)) {
      finalBody = appendOptOutLanguage(text);
      optOutLanguageAppended = true;
    }

    // Message timestamps are real wall-clock (the bubble reads as "now"); the
    // I-QUIET gate above intentionally uses the injectable store clock instead.
    const at = new Date().toISOString();
    const message: SmsMessage = {
      id: crypto.randomUUID(),
      leadId,
      contactId: contact?.id ?? null,
      userId,
      direction: 'outbound',
      fromNumber,
      toNumber,
      body: finalBody,
      providerSid: `SM${crypto.randomUUID().replace(/-/g, '')}`,
      status: 'sent',
      sentAt: at,
      createdAt: at,
      updatedAt: at,
    };
    smsStore.messages.push(message);
    if (idempotencyKey) smsStore.idempotency.set(idempotencyKey, message.id);
    recordSmsSentActivity(leadId, contact?.id ?? null, userId, message.id, finalBody, at);

    return HttpResponse.json({
      smsMessageId: message.id,
      leadId,
      to: toNumber,
      from: fromNumber,
      providerSid: message.providerSid,
      body: finalBody,
      optOutLanguageAppended,
      deduped: false,
    });
  }),
];
