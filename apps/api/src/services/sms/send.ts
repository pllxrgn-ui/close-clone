import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { TelephonyProvider } from '@switchboard/shared/providers';
import { contacts, leads, orgSettings, smsMessages, type Db } from '../../db/index.ts';
import { recordActivity, type ActivityWebhookEmitter } from '../activity/index.ts';
import { isPhoneSuppressed } from '../telephony/suppression.ts';
import { phoneMatchKey } from '../telephony/phone.ts';
import { inferTimezoneFromNumber } from './area-code-timezone.ts';
import { isWithinAllowedHours, parseQuietHours, resolveQuietHoursTimezone } from './quiet-hours.ts';
import { appendOptOutLanguage, bodyHasOptOutLanguage } from './opt-out-language.ts';

/**
 * Outbound SMS send engine (CONTRACTS §C7 `POST /sms/send`, §C6 I-QUIET / I-DNC).
 * This is the ONLY path an SMS reaches `TelephonyProvider.sendSms`, so every
 * compliance rail lives here and the REST API cannot bypass it (I-RAIL-API):
 *
 *   1. I-DNC / suppression (execution time): lead DNC, contact DNC, and an active
 *      phone suppression each BLOCK the send — the provider is never called, and
 *      the route returns C8 SUPPRESSED (422). Hard block, NOT an override prompt.
 *      The suppression is the same global `(kind='phone')` row a STOP inbound
 *      raises via the 3b ingress, so a STOP-then-send is blocked here.
 *   2. I-QUIET: the send must fall inside 8am–9pm recipient-local (area-code
 *      inferred, fallback company tz). Outside ⇒ C8 OUTSIDE_WINDOW (422), never
 *      silently sent.
 *   3. First-contact opt-out language (§4.5): the first outbound SMS to a number
 *      carries STOP opt-out language, so the recipient always has a documented way
 *      to unsubscribe before the second message.
 *
 * The provider call happens AFTER the checks (mirroring the one-off email / dial
 * engines): an `sms_messages` row + exactly one `sms_sent` activity are written
 * only once the provider accepts and returns a sid. Idempotency: a client
 * `idempotencyKey` makes a retry a no-op — the mock/real provider returns the same
 * sid, and the `ON CONFLICT (provider_sid) DO NOTHING` insert dedupes, so the
 * second attempt neither re-persists nor re-emits the timeline event.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

// --- Errors (mapped to C8 codes at the route) ------------------------------

export class SmsSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsSendError';
  }
}

/** Bad request the route's zod did not catch (business rule) → C8 VALIDATION_FAILED. */
export class SmsValidationError extends SmsSendError {
  constructor(message: string) {
    super(message);
    this.name = 'SmsValidationError';
  }
}

export class SmsLeadNotFoundError extends SmsSendError {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`lead ${leadId} not found or soft-deleted`);
    this.name = 'SmsLeadNotFoundError';
    this.leadId = leadId;
  }
}

export class SmsContactNotFoundError extends SmsSendError {
  readonly contactId: string;
  constructor(contactId: string) {
    super(`contact ${contactId} not found or soft-deleted`);
    this.name = 'SmsContactNotFoundError';
    this.contactId = contactId;
  }
}

/** I-DNC / suppression hit at send time → C8 SUPPRESSED (422). Never an override. */
export class SmsSuppressedError extends SmsSendError {
  readonly reason: 'lead_dnc' | 'contact_dnc' | 'phone_suppressed';
  constructor(reason: 'lead_dnc' | 'contact_dnc' | 'phone_suppressed') {
    super(`sms blocked: ${reason}`);
    this.name = 'SmsSuppressedError';
    this.reason = reason;
  }
}

/** I-QUIET violation — send attempted outside the allowed window → C8 OUTSIDE_WINDOW. */
export class SmsQuietHoursError extends SmsSendError {
  readonly timezone: string;
  constructor(timezone: string) {
    super(`sms outside quiet-hours window (8am–9pm ${timezone})`);
    this.name = 'SmsQuietHoursError';
    this.timezone = timezone;
  }
}

/** The underlying provider send failed → C8 PROVIDER_ERROR (502). */
export class SmsProviderError extends SmsSendError {
  constructor(message: string) {
    super(`provider sendSms failed: ${message}`);
    this.name = 'SmsProviderError';
  }
}

// --- Public shape ----------------------------------------------------------

export interface SmsSendDeps {
  db: Db;
  /** Adapter for the outbound send (only `sendSms` is used by this engine). */
  provider: Pick<TelephonyProvider, 'sendSms'>;
  now: () => Date;
  /** Default outbound sender number (the org's Twilio number) when `from` is omitted. */
  fromNumber?: string;
  /** Override the appended first-contact opt-out sentence (§4.5). */
  optOutLanguage?: string;
  /** Fans sms_sent onto activity.recorded webhooks. */
  emitter?: ActivityWebhookEmitter;
}

export interface SmsSendInput {
  /** The rep performing the send (recorded on the activity + sms row). */
  userId: string;
  /** Timeline target. */
  leadId: string;
  /** Recipient contact — DNC + the default destination number. */
  contactId?: string;
  /** Destination number; defaults to the contact's first phone. */
  to?: string;
  /** Sender number; defaults to `deps.fromNumber`. */
  from?: string;
  /** Message body. */
  body: string;
  /** Client key for safe retries (same key ⇒ one send, one activity). */
  idempotencyKey?: string;
}

export interface SmsSendResult {
  smsMessageId: string;
  leadId: string;
  to: string;
  from: string;
  providerSid: string;
  /** The body actually sent (may include appended first-contact opt-out language). */
  body: string;
  /** True iff first-contact opt-out language was appended to the body (§4.5). */
  optOutLanguageAppended: boolean;
  /** True iff a prior send with the same idempotency key already delivered this. */
  deduped: boolean;
}

// --- Loads -----------------------------------------------------------------

interface LeadCtx {
  dnc: boolean;
}

async function loadLead(db: Db, leadId: string): Promise<LeadCtx> {
  const rows = await db
    .select({ dnc: leads.dnc })
    .from(leads)
    .where(and(eq(leads.id, leadId), sql`${leads.deletedAt} is null`))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new SmsLeadNotFoundError(leadId);
  return row;
}

interface ContactCtx {
  id: string;
  dnc: boolean;
  phone: string | null;
}

async function loadContact(db: Db, contactId: string, leadId: string): Promise<ContactCtx> {
  const rows = await db
    .select({
      id: contacts.id,
      leadId: contacts.leadId,
      phones: contacts.phones,
      dnc: contacts.dnc,
    })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), sql`${contacts.deletedAt} is null`))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new SmsContactNotFoundError(contactId);
  if (row.leadId !== leadId) {
    throw new SmsValidationError(`contact ${contactId} does not belong to lead ${leadId}`);
  }
  return { id: row.id, dnc: row.dnc, phone: row.phones[0]?.phone ?? null };
}

interface OrgCtx {
  quietHours: unknown;
  companyTimezone: string;
}

async function loadOrg(db: Db): Promise<OrgCtx> {
  const rows = await db
    .select({ quietHours: orgSettings.quietHours, companyTimezone: orgSettings.companyTimezone })
    .from(orgSettings)
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { quietHours: null, companyTimezone: 'UTC' };
  return { quietHours: row.quietHours, companyTimezone: row.companyTimezone };
}

/** True iff a prior OUTBOUND sms row exists to `key` under this lead (first-contact gate). */
async function hasPriorOutboundSms(db: Db, leadId: string, key: string): Promise<boolean> {
  if (key === '') return false;
  const result = await db.execute(sql`
    SELECT 1
    FROM sms_messages
    WHERE lead_id = ${leadId}
      AND direction = 'outbound'
      AND right(regexp_replace(to_number, '[^0-9]', '', 'g'), 10) = ${key}
    LIMIT 1
  `);
  return (result as { rows: unknown[] }).rows.length > 0;
}

// --- The engine ------------------------------------------------------------

export async function sendSms(deps: SmsSendDeps, input: SmsSendInput): Promise<SmsSendResult> {
  const { db } = deps;
  const now = deps.now();
  const nowIso = now.toISOString();

  const bodyRaw = input.body.trim();
  if (bodyRaw.length === 0) throw new SmsValidationError('body is required');

  const lead = await loadLead(db, input.leadId);
  const contact =
    input.contactId === undefined ? null : await loadContact(db, input.contactId, input.leadId);

  const toNumber = input.to ?? contact?.phone ?? null;
  if (toNumber === null || toNumber.length === 0) {
    throw new SmsValidationError('no destination number (provide `to` or a contact with a phone)');
  }
  const fromNumber = input.from ?? deps.fromNumber ?? null;
  if (fromNumber === null || fromNumber.length === 0) {
    throw new SmsValidationError('no sender number (provide `from` or configure a default)');
  }

  // 1. I-DNC / suppression — hard block BEFORE the provider is touched.
  if (lead.dnc) throw new SmsSuppressedError('lead_dnc');
  if (contact !== null && contact.dnc) throw new SmsSuppressedError('contact_dnc');
  const toKey = phoneMatchKey(toNumber);
  if (await isPhoneSuppressed(db, toKey)) throw new SmsSuppressedError('phone_suppressed');

  // 2. I-QUIET — 8am–9pm recipient-local (area-code inferred, fallback company tz).
  const org = await loadOrg(db);
  const window = parseQuietHours(org.quietHours);
  const recipientTz = inferTimezoneFromNumber(toNumber);
  const tz = resolveQuietHoursTimezone(window, recipientTz, org.companyTimezone);
  if (!isWithinAllowedHours(now, tz, window)) throw new SmsQuietHoursError(tz);

  // 3. First-contact opt-out language (§4.5) — appended only on the first outbound
  //    SMS to this number and only when the body does not already carry STOP text.
  let body = bodyRaw;
  let optOutLanguageAppended = false;
  const firstContact = !(await hasPriorOutboundSms(db, input.leadId, toKey));
  if (firstContact && !bodyHasOptOutLanguage(bodyRaw)) {
    body = appendOptOutLanguage(bodyRaw, deps.optOutLanguage);
    optOutLanguageAppended = true;
  }

  // Provider send OUTSIDE the persistence txn; idempotency key makes a retry safe.
  const key = input.idempotencyKey ?? randomUUID();
  let providerSid: string;
  try {
    const res = await deps.provider.sendSms(fromNumber, toNumber, body, key);
    providerSid = res.sid;
  } catch (err) {
    throw new SmsProviderError(err instanceof Error ? err.message : String(err));
  }

  // Persist + emit exactly one sms_sent; ON CONFLICT dedupes a same-sid retry.
  return db.transaction(async (txRaw): Promise<SmsSendResult> => {
    const tx = txRaw as Db;
    const inserted = await tx
      .insert(smsMessages)
      .values({
        leadId: input.leadId,
        ...(contact !== null ? { contactId: contact.id } : {}),
        userId: input.userId,
        direction: 'outbound',
        fromNumber,
        toNumber,
        body,
        providerSid,
        status: 'sent',
        sentAt: nowIso,
      })
      .onConflictDoNothing({ target: smsMessages.providerSid })
      .returning({ id: smsMessages.id });

    const row = inserted[0];
    if (row === undefined) {
      // Same-sid retry: a prior send already persisted this. No second activity.
      const existing = await tx
        .select({ id: smsMessages.id })
        .from(smsMessages)
        .where(eq(smsMessages.providerSid, providerSid))
        .limit(1);
      return {
        smsMessageId: existing[0]?.id ?? '',
        leadId: input.leadId,
        to: toNumber,
        from: fromNumber,
        providerSid,
        body,
        optOutLanguageAppended,
        deduped: true,
      };
    }

    await recordActivity(
      tx,
      {
        leadId: input.leadId,
        ...(contact !== null ? { contactId: contact.id } : {}),
        userId: input.userId,
        type: 'sms_sent',
        occurredAt: nowIso,
        payload: { smsMessageId: row.id, body, channel: 'sms' },
      },
      deps.emitter,
    );

    return {
      smsMessageId: row.id,
      leadId: input.leadId,
      to: toNumber,
      from: fromNumber,
      providerSid,
      body,
      optOutLanguageAppended,
      deduped: false,
    };
  });
}
