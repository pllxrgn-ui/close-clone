/*
 * The comms in-memory store — module-scope state seeded deterministically from
 * the shared fixture `db` (imported read-only). This is the demo's write layer:
 * enrolling, pausing/resuming, and sending mutate these arrays so counts, lists,
 * and the outbox visibly change within a session and survive route changes
 * (they reset on reload). Shapes are the @switchboard/shared C1 DTOs so the same
 * UI works against the real API later.
 *
 * The shared fixture `db` has no templates/snippets/sequences (those C1 tables
 * were left unseeded by W1), so this feature seeds its own — derived from real
 * fixture leads/contacts/users where relationships matter (enrollments), matching
 * the "build your own seed derived from it" fence.
 */
import type {
  Sequence,
  SequenceEnrollment,
  SequenceStep,
  Snippet,
  Template,
} from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import { mulberry32, uuidFrom } from '../../../mocks/seed.ts';

/** An outbound email as stored in the demo outbox/thread (C1 email_message shape, trimmed). */
export interface OutboxMessage {
  id: string;
  threadId: string;
  leadId: string;
  contactId: string | null;
  to: string[];
  subject: string;
  body: string;
  sentAt: string;
}

export interface CommsState {
  templates: Template[];
  snippets: Snippet[];
  sequences: Sequence[];
  steps: SequenceStep[];
  enrollments: SequenceEnrollment[];
  outbox: OutboxMessage[];
  /** Globally suppressed email addresses (unsubscribe/bounce) — lowercased. */
  suppressedEmails: Set<string>;
}

const SEED = 0x5eeed3;
const NOW = new Date('2026-07-15T17:00:00.000Z');
const iso = (offsetDays: number): string =>
  new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString();

// Stable id factory (uuid-shaped, deterministic) for seed rows.
function makeIds(seed: number): () => string {
  const rng = mulberry32(seed);
  return () => uuidFrom(rng);
}

function seedTemplates(id: () => string): Template[] {
  const base = { ownerId: null, shared: true, createdAt: iso(-120), updatedAt: iso(-9) };
  const rows: Array<Pick<Template, 'name' | 'subject' | 'body'>> = [
    {
      name: 'Intro — first touch',
      subject: 'Quick idea for {{lead.name}}',
      body:
        'Hi {{contact.first_name}},\n\n' +
        'I noticed {{lead.name}} is scaling its sales team. Groups your size usually win back a few hours a week per rep by keeping calls, email, and follow-up in one place instead of five tabs.\n\n' +
        'Worth a quick 15 minutes this week?\n\n' +
        'Best,\n{{owner.name}}',
    },
    {
      name: 'Follow-up nudge',
      subject: 'Re: {{lead.name}}',
      body:
        'Hi {{contact.first_name}},\n\n' +
        "Circling back on my last note — happy to send a short overview instead of a call if that's easier. Either way I'll keep it brief.\n\n" +
        '{{owner.name}}',
    },
    {
      name: 'Renewal check-in',
      subject: '{{lead.name}} renewal — quick check-in',
      body:
        'Hi {{contact.first_name}},\n\n' +
        'Your renewal is coming up and I want to make sure the plan still fits how {{lead.name}} is using Switchboard. Do you have 20 minutes this week?\n\n' +
        'Thanks,\n{{owner.name}}',
    },
    {
      name: 'Proposal recap',
      subject: 'Recap + next steps for {{lead.name}}',
      body:
        'Hi {{contact.first_name}},\n\n' +
        'Thanks for the time today. Recapping what we covered and the proposed next steps below so nothing slips.\n\n' +
        '— {{owner.name}}',
    },
  ];
  return rows.map((r) => ({ id: id(), channel: 'email', ...r, ...base }));
}

function seedSnippets(id: () => string): Snippet[] {
  const base = { ownerId: null, createdAt: iso(-120), updatedAt: iso(-30) };
  const rows: Array<Pick<Snippet, 'shortcut' | 'body'>> = [
    { shortcut: 'avail', body: "I'm around Tue–Thu afternoons ET — does one of those work?" },
    { shortcut: 'calendly', body: 'Grab any open slot here: https://cal.example.com/switchboard' },
    { shortcut: 'sig', body: 'Best,\n{{owner.name}}\nSwitchboard' },
    {
      shortcut: 'pricing',
      body: 'Plans start at $25/user/mo; happy to map the right tier to your team size.',
    },
    { shortcut: 'thanks', body: 'Thanks so much — really appreciate your time.' },
  ];
  return rows.map((r) => ({ id: id(), ...r, ...base }));
}

interface SeqSeed {
  name: string;
  status: Sequence['status'];
  steps: Array<
    Pick<SequenceStep, 'type' | 'delayHours' | 'requiresReview'> & { templateName?: string }
  >;
  /** How many active + paused enrollments to seed for this sequence. */
  active: number;
  paused: number;
}

const SEQUENCE_SEEDS: readonly SeqSeed[] = [
  {
    name: 'Onboarding',
    status: 'active',
    active: 6,
    paused: 2,
    steps: [
      { type: 'email', delayHours: 0, requiresReview: false, templateName: 'Intro — first touch' },
      { type: 'call_task', delayHours: 48, requiresReview: false },
      { type: 'email', delayHours: 96, requiresReview: true, templateName: 'Follow-up nudge' },
    ],
  },
  {
    name: 'Renewal outreach',
    status: 'active',
    active: 4,
    paused: 1,
    steps: [
      { type: 'email', delayHours: 0, requiresReview: false, templateName: 'Renewal check-in' },
      { type: 'email', delayHours: 72, requiresReview: false, templateName: 'Follow-up nudge' },
      { type: 'sms', delayHours: 120, requiresReview: false },
    ],
  },
  {
    name: 'Win-back',
    status: 'active',
    active: 3,
    paused: 0,
    steps: [
      { type: 'email', delayHours: 0, requiresReview: false, templateName: 'Intro — first touch' },
      { type: 'email', delayHours: 168, requiresReview: true, templateName: 'Proposal recap' },
    ],
  },
  {
    name: 'Cold intro (archived)',
    status: 'archived',
    active: 0,
    paused: 0,
    steps: [
      { type: 'email', delayHours: 0, requiresReview: false, templateName: 'Intro — first touch' },
      { type: 'email', delayHours: 96, requiresReview: false, templateName: 'Follow-up nudge' },
    ],
  },
];

/** Lead/contact pairs from the fixture, in a stable order, for seeding enrollments. */
function enrollmentCandidates(): Array<{ leadId: string; contactId: string }> {
  const firstContactByLead = new Map<string, string>();
  for (const c of db.contacts) {
    if (c.deletedAt === null && !firstContactByLead.has(c.leadId)) {
      firstContactByLead.set(c.leadId, c.id);
    }
  }
  const out: Array<{ leadId: string; contactId: string }> = [];
  for (const lead of db.leads) {
    const contactId = firstContactByLead.get(lead.id);
    if (contactId) out.push({ leadId: lead.id, contactId });
  }
  return out;
}

function buildInitialState(): CommsState {
  const id = makeIds(SEED);
  const templates = seedTemplates(id);
  const snippets = seedSnippets(id);
  const templateByName = new Map(templates.map((t) => [t.name, t.id]));

  const sequences: Sequence[] = [];
  const steps: SequenceStep[] = [];
  const enrollments: SequenceEnrollment[] = [];
  const candidates = enrollmentCandidates();
  const owner = db.users[0]?.id ?? null;
  let candidateCursor = 0;

  for (const seed of SEQUENCE_SEEDS) {
    const seqId = id();
    sequences.push({
      id: seqId,
      name: seed.name,
      status: seed.status,
      settings: {},
      createdAt: iso(-90),
      updatedAt: iso(-3),
    });
    seed.steps.forEach((s, i) => {
      steps.push({
        id: id(),
        sequenceId: seqId,
        sortOrder: i,
        type: s.type,
        delayHours: s.delayHours,
        templateId: s.templateName ? (templateByName.get(s.templateName) ?? null) : null,
        requiresReview: s.requiresReview,
        condition: null,
        createdAt: iso(-90),
        updatedAt: iso(-90),
      });
    });
    const enroll = (state: 'active' | 'paused'): void => {
      const cand = candidates[candidateCursor % candidates.length];
      candidateCursor += 1;
      if (!cand) return;
      enrollments.push({
        id: id(),
        sequenceId: seqId,
        leadId: cand.leadId,
        contactId: cand.contactId,
        emailAccountId: null,
        enrolledBy: owner,
        state,
        pausedReason: state === 'paused' ? 'reply' : null,
        createdAt: iso(-14),
        updatedAt: state === 'paused' ? iso(-2) : iso(-14),
      });
    };
    for (let i = 0; i < seed.active; i += 1) enroll('active');
    for (let i = 0; i < seed.paused; i += 1) enroll('paused');
  }

  // Seed a couple of globally suppressed addresses (unsubscribe/bounce) so the
  // composer's compliance rail is demonstrable even on a non-DNC lead. Picks the
  // first contact email of the 3rd and 7th enrollment candidates (stable).
  const suppressedEmails = new Set<string>();
  for (const idx of [2, 6]) {
    const cand = candidates[idx];
    if (!cand) continue;
    const contact = db.contacts.find((c) => c.id === cand.contactId);
    const email = contact?.emails[0]?.email;
    if (email) suppressedEmails.add(email.toLowerCase());
  }

  return { templates, snippets, sequences, steps, enrollments, outbox: [], suppressedEmails };
}

/** The live, mutable store. Handlers read and write this object's arrays. */
export const commsStore: CommsState = buildInitialState();

/** Re-seed to the initial deterministic state (used by tests for isolation). */
export function resetCommsStore(): void {
  Object.assign(commsStore, buildInitialState());
}

/** Count active/paused enrollments for a sequence (list + detail counts). */
export function enrollmentCounts(sequenceId: string): { active: number; paused: number } {
  let active = 0;
  let paused = 0;
  for (const e of commsStore.enrollments) {
    if (e.sequenceId !== sequenceId) continue;
    if (e.state === 'active') active += 1;
    else if (e.state === 'paused') paused += 1;
  }
  return { active, paused };
}

/** True when an email is DNC-suppressed (case-insensitive). */
export function isEmailSuppressed(email: string): boolean {
  return commsStore.suppressedEmails.has(email.trim().toLowerCase());
}
