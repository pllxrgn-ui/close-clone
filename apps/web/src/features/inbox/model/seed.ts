import type { Contact, Lead } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import { int, mulberry32, pick, uuidFrom } from '../../../mocks/seed.ts';
import type { InboxChannel } from './types.ts';
import type { InboxStoreData, StoredReview, StoredTask, StoredThread } from './store.ts';
import { INBOX_NOW_MS } from './time.ts';

/*
 * Deterministic Inbox seed — built ONCE from the shared fixture `db` (read-only),
 * so the queue is coherent with the leads board (the same amber/jade leads line
 * up) and byte-identical on every load. The fixture has no tasks / threads /
 * sequence intents, so we synthesize them from the leads' denormalized signals:
 *
 *   - replies  ← leads with an unanswered inbound (lastInboundAt > lastContactedAt)
 *   - tasks    ← leads with a past-due nextTaskDueAt
 *   - reviews  ← a curated set of non-DNC leads, given a sequence step to review
 *
 * The queue is intentionally capped to a demo-sized, clearable set (the real API
 * paginates via the C7 keyset envelope); everything else about the merge is real.
 */

const SEED = 0x1_7b0c;
const HOUR = 3_600_000;

const MAX_REPLIES = 6;
const MAX_TASKS = 6;
const MAX_REVIEWS = 4;
/** Tasks pre-completed "earlier today" — the starting "Done today" baseline. */
const BASELINE_DONE = 8;

const iso = (ms: number): string => new Date(ms).toISOString();
const hoursAgo = (n: number): string => iso(INBOX_NOW_MS - n * HOUR);

const REPLY_SUBJECTS = [
  'Re: Pricing for the Enterprise tier',
  'Re: Pilot rollout timeline',
  'Question about the security review',
  'Re: Contract redlines attached',
  'Can we move the demo to Thursday?',
  'Re: Onboarding for the new seats',
  'Follow-up on the proposal',
  'Re: Integration scope',
] as const;

const EMAIL_SNIPPETS = [
  'Thanks — this looks close. Two questions on the annual terms…',
  'Looping in our VP of Eng. Can you send the SOC 2 report?',
  'We are ready to move forward. What do you need from us?',
  'Redlines attached — mostly the liability cap and the SLA.',
  'Could we push the kickoff a week? Quarter-end crunch.',
  'The team loved the demo. Sending this up for budget sign-off.',
] as const;

const SMS_SNIPPETS = [
  'Got your voicemail — free after 3pm?',
  'Yes, Thursday works. Send an invite?',
  'Can you resend the quote? Lost the thread.',
  'We are in. Who signs the order form?',
] as const;

const TASK_TITLES = [
  'Follow up on pricing',
  'Send the proposal recap',
  'Confirm next steps after the demo',
  'Chase the signed order form',
  'Schedule the technical review',
  'Check in on the security questionnaire',
  'Recap the pilot results',
  'Loop in the exec sponsor',
] as const;

const SEQUENCES = [
  'Onboarding',
  'Q3 Outbound',
  'Renewal push',
  'Trial nurture',
  'Win-back',
] as const;

const STEP_SUBJECTS = [
  'A quick idea for your team',
  'Following up on my last note',
  'Worth a 15-minute look?',
  'Checking in before quarter-end',
] as const;

const STEP_PREVIEWS = [
  'Hi {first} — saw you are scaling the team. Most groups your size…',
  'Wanted to bump this in case it slipped. Happy to send a short loom…',
  'Circling back one more time — if now is not right, no problem at all…',
  'Quick note before the quarter closes: we can turn this around fast…',
] as const;

function firstContact(leadId: string): Contact | undefined {
  return db.contacts.find((c) => c.leadId === leadId && c.deletedAt === null);
}

function contactName(contact: Contact | undefined): string {
  return contact?.name ?? 'Primary contact';
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? 'there';
}

function emailFor(contact: Contact | undefined, lead: Lead): string {
  const entry = contact?.emails[0]?.email;
  if (entry) return entry;
  const slug = lead.name.toLowerCase().replace(/\s+/g, '-');
  return `hello@${slug}.example.com`;
}

function phoneFor(contact: Contact | undefined, rng: () => number): string {
  const entry = contact?.phones[0]?.phone;
  return entry ?? `+1206${int(rng, 1_000_000, 9_999_999)}`;
}

/** Unanswered inbound: an inbound arrived after (or with no) last outbound touch. */
function hasUnansweredInbound(lead: Lead): boolean {
  if (!lead.lastInboundAt) return false;
  const inbound = Date.parse(lead.lastInboundAt);
  const contacted = lead.lastContactedAt ? Date.parse(lead.lastContactedAt) : -Infinity;
  return inbound > contacted;
}

export function buildInboxSeed(): InboxStoreData {
  const rng = mulberry32(SEED);

  const threads = new Map<string, StoredThread>();
  const tasks = new Map<string, StoredTask>();
  const reviews = new Map<string, StoredReview>();
  const leadNames = new Map<string, string>();
  const leadDnc = new Map<string, boolean>();

  for (const lead of db.leads) {
    leadNames.set(lead.id, lead.name);
    leadDnc.set(lead.id, lead.dnc);
  }

  const replyLeadIds = new Set<string>();

  // ── (a) Replies: unanswered inbound on non-DNC leads ────────────────────────
  const replyLeads = db.leads
    .filter((l) => !l.dnc && hasUnansweredInbound(l))
    .slice(0, MAX_REPLIES);
  replyLeads.forEach((lead, i) => {
    const contact = firstContact(lead.id);
    const channel: InboxChannel = i % 4 === 3 ? 'sms' : 'email';
    const receivedAt = lead.lastInboundAt ?? hoursAgo(int(rng, 1, 20));
    const subject = channel === 'email' ? pick(rng, REPLY_SUBJECTS) : null;
    const snippet = channel === 'email' ? pick(rng, EMAIL_SNIPPETS) : pick(rng, SMS_SNIPPETS);
    const id = uuidFrom(rng);
    threads.set(id, {
      id,
      leadId: lead.id,
      contactId: contact?.id ?? null,
      contactName: contactName(contact),
      channel,
      toAddress: channel === 'email' ? emailFor(contact, lead) : phoneFor(contact, rng),
      subject,
      snippet,
      lastInboundAt: receivedAt,
      lastContactedAt: lead.lastContactedAt,
      answered: false,
      answeredAt: null,
      snoozedUntil: null,
      messages: [
        {
          id: uuidFrom(rng),
          direction: 'in',
          subject,
          body: snippet,
          at: receivedAt,
        },
      ],
    });
    replyLeadIds.add(lead.id);
  });

  // ── (b) Tasks: past-due nextTaskDueAt ───────────────────────────────────────
  const taskLeads = db.leads
    .filter((l) => l.nextTaskDueAt !== null && Date.parse(l.nextTaskDueAt) <= INBOX_NOW_MS)
    .slice(0, MAX_TASKS);
  taskLeads.forEach((lead, i) => {
    const id = uuidFrom(rng);
    tasks.set(id, {
      id,
      leadId: lead.id,
      title: pick(rng, TASK_TITLES),
      dueAt: lead.nextTaskDueAt ?? hoursAgo(int(rng, 2, 40)),
      completedAt: null,
      snoozedUntil: null,
    });
    // Give the first task-lead a SECOND due task, so completing one recomputes
    // the lead's next task to the other (rather than clearing it entirely).
    if (i === 0) {
      const id2 = uuidFrom(rng);
      tasks.set(id2, {
        id: id2,
        leadId: lead.id,
        title: 'Send the follow-up email',
        dueAt: hoursAgo(int(rng, 30, 52)),
        completedAt: null,
        snoozedUntil: null,
      });
    }
  });

  // ── (c) Reviews: sequence steps awaiting review, on fresh non-DNC leads ──────
  const reviewLeads = db.leads
    .filter((l) => !l.dnc && !replyLeadIds.has(l.id))
    .slice(0, MAX_REVIEWS);
  reviewLeads.forEach((lead) => {
    const contact = firstContact(lead.id);
    const channel: InboxChannel = 'email';
    const stepCount = int(rng, 3, 5);
    const stepIndex = int(rng, 2, stepCount);
    const preview = pick(rng, STEP_PREVIEWS).replace('{first}', firstName(contactName(contact)));
    const id = uuidFrom(rng);
    reviews.set(id, {
      id,
      enrollmentId: uuidFrom(rng),
      stepId: uuidFrom(rng),
      sequenceId: uuidFrom(rng),
      leadId: lead.id,
      contactId: contact?.id ?? null,
      contactName: contactName(contact),
      sequenceName: pick(rng, SEQUENCES),
      stepIndex,
      stepCount,
      channel,
      subject: pick(rng, STEP_SUBJECTS),
      preview,
      dueAt: hoursAgo(int(rng, 1, 30)),
      state: 'AWAITING_REVIEW',
      disposition: null,
      dispositionedAt: null,
      snoozedUntil: null,
    });
  });

  // ── Baseline "Done today": tasks already checked off earlier today ──────────
  const doneLeads = db.leads
    .filter((l) => !taskLeads.includes(l) && !replyLeadIds.has(l.id))
    .slice(0, BASELINE_DONE);
  doneLeads.forEach((lead) => {
    const id = uuidFrom(rng);
    tasks.set(id, {
      id,
      leadId: lead.id,
      title: pick(rng, TASK_TITLES),
      dueAt: hoursAgo(int(rng, 6, 14)),
      completedAt: hoursAgo(int(rng, 1, 5)),
      snoozedUntil: null,
    });
  });

  return { threads, tasks, reviews, leadNames, leadDnc };
}
