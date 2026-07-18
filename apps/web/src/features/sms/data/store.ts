/*
 * The two-way SMS demo store — module-scope state seeded deterministically from the
 * shared fixture `db` (imported read-only). This is the demo's SMS write layer:
 * sending a text appends an outbound row here (and the MSW handler fans an
 * `sms_sent` activity onto the shared lead timeline), so the conversation thread
 * changes within a session and survives route changes (it resets on reload).
 *
 * Rows are the @switchboard/shared C1 `SmsMessage` shape so the same thread UI
 * renders identically against the real API once a lead-scoped SMS read route lands
 * (reported as contract friction — no C7 GET currently returns sms_messages).
 *
 * Compliance state that the send rails read at execution time lives here too:
 *   - `suppressedNumbers` — the global `(kind='phone')` STOP/opt-out suppression the
 *     real engine keeps; a seeded number plus any inbound STOP in a thread.
 *   - `clock` — the instant the I-QUIET quiet-hours gate evaluates against. Fixed
 *     inside the 8am–9pm window by default so the demo always sends; tests override
 *     it to exercise the OUTSIDE_WINDOW path deterministically.
 */
import type { SmsMessage } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import { mulberry32, uuidFrom } from '../../../mocks/seed.ts';
import { phoneMatchKey } from '../lib/sms.ts';

/** The org's outbound SMS sender number (the Switchboard Twilio number). */
export const ORG_SMS_NUMBER = '+12065550100';
/** Fallback timezone for quiet-hours when an area code cannot be inferred. */
export const COMPANY_TIMEZONE = 'America/New_York';

/** A fixed instant INSIDE the 8am–9pm window (10am PT / 1pm ET) — the default clock. */
const WITHIN_WINDOW = new Date('2026-07-15T17:00:00.000Z');

export interface SmsState {
  /** Every SMS row across all leads, in insertion order. */
  messages: SmsMessage[];
  /** Globally suppressed phone match-keys (STOP/opt-out) — the send rail reads this. */
  suppressedNumbers: Set<string>;
  /** idempotencyKey → smsMessageId, so a retried send is a no-op (deduped). */
  idempotency: Map<string, string>;
  /** The instant the quiet-hours gate + composer note evaluate against (overridable). */
  clock: () => Date;
}

const SEED = 0x5b_a5ed;
const SEED_NOW = new Date('2026-07-15T16:40:00.000Z');
const iso = (minutesAgo: number): string =>
  new Date(SEED_NOW.getTime() - minutesAgo * 60_000).toISOString();

interface Turn {
  dir: 'inbound' | 'outbound';
  body: string;
  /** Minutes before SEED_NOW this turn occurred (larger = older). */
  minsAgo: number;
  /** Outbound delivery status; inbound rows are always 'received'. */
  status?: 'delivered' | 'sent' | 'failed';
}

/** Conversation scripts — real operator cadence, not lorem. Assigned round-robin. */
const ACTIVE_SCRIPTS: readonly Turn[][] = [
  [
    {
      dir: 'outbound',
      body: 'Hi — Ben from Switchboard. Following up on the demo you booked. Reply STOP to unsubscribe.',
      minsAgo: 5040,
      status: 'delivered',
    },
    { dir: 'inbound', body: 'Hey Ben — yes, still on for Thursday?', minsAgo: 4980 },
    {
      dir: 'outbound',
      body: 'Thursday 2pm works. I’ll send a calendar hold now.',
      minsAgo: 4900,
      status: 'delivered',
    },
    { dir: 'inbound', body: 'Perfect, talk then 👍', minsAgo: 4880 },
  ],
  [
    {
      dir: 'outbound',
      body: 'Quick nudge before the weekend — did the pricing sheet make sense? Reply STOP to unsubscribe.',
      minsAgo: 2880,
      status: 'delivered',
    },
    { dir: 'inbound', body: 'It did. Need to loop in finance, back to you Monday.', minsAgo: 2810 },
    {
      dir: 'outbound',
      body: 'Sounds good, no rush. Here if questions come up.',
      minsAgo: 2760,
      status: 'sent',
    },
  ],
  [
    {
      dir: 'outbound',
      body: 'Congrats on the funding round! Worth a quick call on scaling the sales floor? Reply STOP to unsubscribe.',
      minsAgo: 1500,
      status: 'delivered',
    },
    {
      dir: 'inbound',
      body: 'Ha, thanks. Maybe — what times are you open next week?',
      minsAgo: 1440,
    },
  ],
  [
    {
      dir: 'outbound',
      body: 'Recap from today’s call is in your inbox. Anything I missed? Reply STOP to unsubscribe.',
      minsAgo: 360,
      status: 'sent',
    },
  ],
];

interface SeedContext {
  id: () => string;
  ownerId: string | null;
}

function firstPhoneContact(leadId: string): { contactId: string; phone: string } | null {
  for (const c of db.contacts) {
    if (c.leadId !== leadId || c.deletedAt !== null) continue;
    const phone = c.phones[0]?.phone;
    if (phone) return { contactId: c.id, phone };
    return null; // only consider the lead's FIRST contact (mirrors the composer default)
  }
  return null;
}

function scriptToMessages(
  ctx: SeedContext,
  leadId: string,
  contactId: string,
  peerNumber: string,
  turns: readonly Turn[],
): SmsMessage[] {
  return turns.map((turn) => {
    const at = iso(turn.minsAgo);
    const outbound = turn.dir === 'outbound';
    return {
      id: ctx.id(),
      leadId,
      contactId,
      userId: outbound ? ctx.ownerId : null,
      direction: turn.dir,
      fromNumber: outbound ? ORG_SMS_NUMBER : peerNumber,
      toNumber: outbound ? peerNumber : ORG_SMS_NUMBER,
      body: turn.body,
      providerSid: `SM${ctx.id().replace(/-/g, '').slice(0, 30)}`,
      status: outbound ? (turn.status ?? 'sent') : 'received',
      sentAt: at,
      createdAt: at,
      updatedAt: at,
    };
  });
}

function buildInitialState(): SmsState {
  const rng = mulberry32(SEED);
  const ctx: SeedContext = { id: () => uuidFrom(rng), ownerId: db.users[0]?.id ?? null };

  const messages: SmsMessage[] = [];
  const suppressedNumbers = new Set<string>();

  const phoneLeads = db.leads
    .filter((l) => l.deletedAt === null && !l.dnc)
    .map((l) => ({ lead: l, contact: firstPhoneContact(l.id) }))
    .filter(
      (
        x,
      ): x is { lead: (typeof db.leads)[number]; contact: { contactId: string; phone: string } } =>
        x.contact !== null,
    );

  // Active, sendable conversations (round-robin over the scripts).
  const activeCount = Math.min(4, phoneLeads.length);
  for (let i = 0; i < activeCount; i += 1) {
    const { lead, contact } = phoneLeads[i]!;
    const script = ACTIVE_SCRIPTS[i % ACTIVE_SCRIPTS.length]!;
    messages.push(...scriptToMessages(ctx, lead.id, contact.contactId, contact.phone, script));
  }

  // An opted-out conversation: the recipient texted STOP, so the number is globally
  // suppressed and the composer must block (I-DNC/suppression, C8 SUPPRESSED).
  const optedOut = phoneLeads[activeCount];
  if (optedOut) {
    const { lead, contact } = optedOut;
    messages.push(
      ...scriptToMessages(ctx, lead.id, contact.contactId, contact.phone, [
        {
          dir: 'outbound',
          body: 'Hi from Switchboard — following up on your trial. Reply STOP to unsubscribe.',
          minsAgo: 600,
          status: 'delivered',
        },
        { dir: 'inbound', body: 'STOP', minsAgo: 540 },
      ]),
    );
    suppressedNumbers.add(phoneMatchKey(contact.phone));
  }

  // A DNC lead: seed a short prior thread so the drawer is not empty; the composer
  // blocks on the lead's dnc flag regardless of the number.
  const dncLead = db.leads.find((l) => l.deletedAt === null && l.dnc);
  if (dncLead) {
    const contact = firstPhoneContact(dncLead.id);
    if (contact) {
      messages.push(
        ...scriptToMessages(ctx, dncLead.id, contact.contactId, contact.phone, [
          {
            dir: 'outbound',
            body: 'Checking in on next steps — let me know a good time. Reply STOP to unsubscribe.',
            minsAgo: 8640,
            status: 'delivered',
          },
          { dir: 'inbound', body: 'Please take us off your list for now.', minsAgo: 8580 },
        ]),
      );
    }
  }

  return { messages, suppressedNumbers, idempotency: new Map(), clock: () => WITHIN_WINDOW };
}

/** The live, mutable store. Handlers read and write this object's arrays/maps. */
export const smsStore: SmsState = buildInitialState();

/** Re-seed to the initial deterministic state (used by tests for isolation). */
export function resetSmsStore(): void {
  const fresh = buildInitialState();
  smsStore.messages = fresh.messages;
  smsStore.suppressedNumbers = fresh.suppressedNumbers;
  smsStore.idempotency = fresh.idempotency;
  smsStore.clock = fresh.clock;
}

/** A lead's SMS rows, chronological (oldest → newest) for the chat thread. */
export function messagesForLead(leadId: string): SmsMessage[] {
  return smsStore.messages
    .filter((m) => m.leadId === leadId)
    .sort((a, b) => {
      const at = a.sentAt ?? a.createdAt;
      const bt = b.sentAt ?? b.createdAt;
      return at === bt ? a.id.localeCompare(b.id) : at < bt ? -1 : 1;
    });
}

/** True iff a number is globally suppressed (STOP/opt-out) — the send rail check. */
export function isNumberSuppressed(number: string): boolean {
  return smsStore.suppressedNumbers.has(phoneMatchKey(number));
}

/** The first non-DNC lead that has a seeded, sendable conversation (demo entry point). */
export function primaryDemoLeadId(): string | null {
  const first = smsStore.messages.find((m) => m.direction === 'outbound');
  return first?.leadId ?? null;
}
