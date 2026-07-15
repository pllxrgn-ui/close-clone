/*
 * One shared fixture module used by BOTH the browser worker (dev) and the node
 * server (tests). Deterministic: a fixed seed drives a mulberry32 PRNG, so the
 * dataset is byte-identical on every load — no Math.random at module scope.
 *
 * Shapes are the @switchboard/shared domain DTOs (C1/C7 camelCase), so the mock
 * can never drift from the contract the real API speaks. Denormalized hot
 * columns (dnc, lastContactedAt, nextTaskDueAt, per-channel last-touch) are
 * populated so state-driven UI (overdue / new-reply / in-sequence / DNC) has
 * real data to color.
 */
import type {
  Activity,
  Contact,
  Lead,
  LeadStatus,
  Opportunity,
  OpportunityStage,
  SmartView,
  User,
} from '@switchboard/shared';
import { parse } from '@switchboard/shared';
import type { SearchHit } from '../api/types.ts';
import { chance, int, mulberry32, pick, uuidFrom } from './seed.ts';

const SEED = 0x5b0a2d;

// Anchor all timestamps to a fixed instant so relative-time state is stable.
const REFERENCE_NOW = new Date('2026-07-15T17:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function isoAt(offsetMs: number): string {
  return new Date(REFERENCE_NOW.getTime() + offsetMs).toISOString();
}
const hoursAgo = (n: number): string => isoAt(-n * HOUR);
const daysAgo = (n: number): string => isoAt(-n * DAY);
const daysAhead = (n: number): string => isoAt(n * DAY);

export interface MockDb {
  users: User[];
  leadStatuses: LeadStatus[];
  opportunityStages: OpportunityStage[];
  leads: Lead[];
  contacts: Contact[];
  opportunities: Opportunity[];
  /** Timeline events keyed by leadId, pre-sorted newest-first (occurredAt, id). */
  activitiesByLead: Map<string, Activity[]>;
  smartViews: SmartView[];
  searchIndex: SearchHit[];
}

const USER_SEEDS: ReadonlyArray<{ name: string; email: string; role: 'rep' | 'admin' }> = [
  { name: 'Ada Okafor', email: 'ada@switchboard.test', role: 'admin' },
  { name: 'Ben Reyes', email: 'ben@switchboard.test', role: 'rep' },
  { name: 'Chloe Nguyen', email: 'chloe@switchboard.test', role: 'rep' },
  { name: 'Diego Santos', email: 'diego@switchboard.test', role: 'rep' },
  { name: 'Priya Menon', email: 'priya@switchboard.test', role: 'rep' },
];

const STATUS_LABELS = ['Potential', 'Contacted', 'Qualified', 'Won', 'Lost'];
const STAGE_LABELS = ['Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];

const COMPANY_PREFIX = [
  'North',
  'Bright',
  'Iron',
  'Blue',
  'Quantum',
  'Cedar',
  'Vertex',
  'Apex',
  'Nova',
  'Summit',
  'Harbor',
  'Delta',
  'Orbit',
  'Sable',
  'Copper',
  'Willow',
  'Granite',
  'Aurora',
  'Pioneer',
  'Meridian',
];
const COMPANY_SUFFIX = [
  'Labs',
  'Systems',
  'Retail',
  'Health',
  'Freight',
  'Media',
  'Analytics',
  'Robotics',
  'Foods',
  'Capital',
  'Security',
  'Cloud',
  'Dynamics',
  'Networks',
  'Interactive',
  'Logistics',
  'Ventures',
  'Industries',
  'Group',
  'Studio',
];
const FIRST_NAMES = [
  'Sam',
  'Jordan',
  'Riley',
  'Casey',
  'Morgan',
  'Taylor',
  'Jamie',
  'Quinn',
  'Avery',
  'Devon',
  'Harper',
  'Reese',
  'Rowan',
  'Skyler',
  'Emerson',
  'Kai',
];
const LAST_NAMES = [
  'Patel',
  'Kim',
  'Garcia',
  'Cohen',
  'Osei',
  'Ivanov',
  'Costa',
  'Haddad',
  'Novak',
  'Silva',
  'Walsh',
  'Rossi',
  'Berg',
  'Flores',
  'Adeyemi',
  'Larsen',
];
const SEGMENTS = ['SMB', 'Mid-Market', 'Enterprise'];
const REGIONS = ['NA-East', 'NA-West', 'EMEA', 'APAC', 'LATAM'];

// Curated activity types (subset of the C4 taxonomy) that render as timeline rows.
const TIMELINE_TYPES = [
  'lead_created',
  'email_sent',
  'email_received',
  'call_logged',
  'note_added',
  'task_created',
  'task_completed',
  'status_changed',
  'sequence_enrolled',
  'sequence_step_sent',
  'sms_sent',
] as const;

function buildDb(): MockDb {
  const rng = mulberry32(SEED);

  const users: User[] = USER_SEEDS.map((seed) => ({
    id: uuidFrom(rng),
    email: seed.email,
    name: seed.name,
    role: seed.role,
    idpSubject: `dev|${seed.email}`,
    isActive: true,
    timezone: 'America/New_York',
    createdAt: daysAgo(420),
    updatedAt: daysAgo(int(rng, 1, 40)),
  }));

  const leadStatuses: LeadStatus[] = STATUS_LABELS.map((label, i) => ({
    id: uuidFrom(rng),
    label,
    sortOrder: i,
    createdAt: daysAgo(420),
    updatedAt: daysAgo(420),
  }));

  const opportunityStages: OpportunityStage[] = STAGE_LABELS.map((label, i) => ({
    id: uuidFrom(rng),
    label,
    sortOrder: i,
    createdAt: daysAgo(420),
    updatedAt: daysAgo(420),
  }));

  // Weighted status distribution (more early-funnel than closed).
  const statusWeights: LeadStatus[] = [];
  const weights = [5, 4, 3, 1, 1];
  leadStatuses.forEach((status, i) => {
    for (let n = 0; n < (weights[i] ?? 1); n += 1) statusWeights.push(status);
  });

  const leads: Lead[] = [];
  const contacts: Contact[] = [];
  const opportunities: Opportunity[] = [];
  const activitiesByLead = new Map<string, Activity[]>();

  const LEAD_COUNT = 224;
  for (let i = 0; i < LEAD_COUNT; i += 1) {
    const id = uuidFrom(rng);
    const owner = pick(rng, users);
    const status = pick(rng, statusWeights);
    const name = `${pick(rng, COMPANY_PREFIX)} ${pick(rng, COMPANY_SUFFIX)}`;
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    const createdDays = int(rng, 4, 380);

    const dnc = chance(rng, 0.12);
    const hasNewReply = chance(rng, 0.24);
    const lastInboundAt = hasNewReply
      ? hoursAgo(int(rng, 1, 44))
      : chance(rng, 0.5)
        ? daysAgo(int(rng, 3, 90))
        : null;
    const lastContactedAt = chance(rng, 0.85) ? daysAgo(int(rng, 0, 70)) : null;

    const taskRoll = rng();
    const nextTaskDueAt =
      taskRoll < 0.28
        ? hoursAgo(int(rng, 2, 60)) // overdue
        : taskRoll < 0.6
          ? daysAhead(int(rng, 1, 21)) // upcoming
          : null;

    const lead: Lead = {
      id,
      name,
      url: `https://${slug}.example.com`,
      description: `${pick(rng, SEGMENTS)} account in ${pick(rng, REGIONS)}.`,
      statusId: status.id,
      ownerId: owner.id,
      custom: {
        segment: pick(rng, SEGMENTS),
        region: pick(rng, REGIONS),
        employees: int(rng, 5, 5000),
      },
      lastContactedAt,
      lastInboundAt,
      nextTaskDueAt,
      lastCallAt: chance(rng, 0.5) ? daysAgo(int(rng, 1, 60)) : null,
      lastEmailAt: chance(rng, 0.7) ? daysAgo(int(rng, 0, 45)) : null,
      lastSmsAt: chance(rng, 0.2) ? daysAgo(int(rng, 1, 40)) : null,
      dnc,
      deletedAt: null,
      createdAt: daysAgo(createdDays),
      updatedAt: daysAgo(int(rng, 0, 4)),
    };
    leads.push(lead);

    // 1–3 contacts per lead.
    const contactCount = int(rng, 1, 3);
    for (let c = 0; c < contactCount; c += 1) {
      const first = pick(rng, FIRST_NAMES);
      const last = pick(rng, LAST_NAMES);
      const contact: Contact = {
        id: uuidFrom(rng),
        leadId: id,
        name: `${first} ${last}`,
        title: chance(rng, 0.8)
          ? pick(rng, ['VP Sales', 'CTO', 'Founder', 'Ops Lead', 'PM'])
          : null,
        emails: [
          {
            email: `${first.toLowerCase()}.${last.toLowerCase()}@${slug}.example.com`,
            type: 'work',
          },
        ],
        phones: chance(rng, 0.6)
          ? [{ phone: `+1206${int(rng, 1000000, 9999999)}`, type: 'mobile' }]
          : [],
        dnc: dnc && c === 0 ? true : chance(rng, 0.05),
        deletedAt: null,
        createdAt: lead.createdAt,
        updatedAt: lead.updatedAt,
      };
      contacts.push(contact);
    }

    // ~40% of leads carry one opportunity.
    if (chance(rng, 0.4)) {
      const stage = pick(rng, opportunityStages);
      const oppStatus =
        status.label === 'Won' ? 'won' : status.label === 'Lost' ? 'lost' : 'active';
      opportunities.push({
        id: uuidFrom(rng),
        leadId: id,
        contactId: null,
        valueCents: int(rng, 5, 240) * 100_000,
        currency: 'USD',
        stageId: stage.id,
        confidence: int(rng, 5, 95),
        closeDate: daysAhead(int(rng, 5, 90)).slice(0, 10),
        ownerId: owner.id,
        status: oppStatus,
        note: null,
        createdAt: lead.createdAt,
        updatedAt: lead.updatedAt,
      });
    }

    // Timeline: 3–9 events, newest first.
    const eventCount = int(rng, 3, 9);
    const events: Activity[] = [];
    for (let e = 0; e < eventCount; e += 1) {
      const type = e === eventCount - 1 ? 'lead_created' : pick(rng, TIMELINE_TYPES);
      events.push({
        id: uuidFrom(rng),
        leadId: id,
        contactId: null,
        userId: type === 'email_received' || type === 'lead_created' ? null : owner.id,
        type,
        occurredAt: hoursAgo(int(rng, 1, 24 * 80)),
        payload: { channel: 'mock' },
        createdAt: daysAgo(createdDays),
        updatedAt: daysAgo(createdDays),
      });
    }
    events.sort((a, b) =>
      a.occurredAt === b.occurredAt ? (a.id < b.id ? 1 : -1) : a.occurredAt < b.occurredAt ? 1 : -1,
    );
    activitiesByLead.set(id, events);
  }

  // Newest-first default order for the leads list (createdAt desc, id desc).
  leads.sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );

  const smartViews = buildSmartViews(rng, users);
  const searchIndex = buildSearchIndex(leads, contacts, leadStatuses);

  return {
    users,
    leadStatuses,
    opportunityStages,
    leads,
    contacts,
    opportunities,
    activitiesByLead,
    smartViews,
    searchIndex,
  };
}

const SMART_VIEW_SEEDS: ReadonlyArray<{ name: string; dsl: string; shared: boolean }> = [
  {
    name: 'My open leads',
    dsl: 'owner in (me) and status != "Won" and status != "Lost"',
    shared: false,
  },
  { name: 'Overdue follow-ups', dsl: 'next_task_due < today', shared: true },
  { name: 'New replies (48h)', dsl: 'has inbound_email within 2 d', shared: true },
  { name: 'In onboarding sequence', dsl: 'has in_sequence("Onboarding")', shared: true },
  { name: 'Do not contact', dsl: 'dnc = true', shared: true },
  { name: 'High-value opportunities', dsl: 'opportunity.value > 5000', shared: false },
  { name: 'Recently contacted', dsl: 'last_contacted > 7 d ago', shared: false },
];

function buildSmartViews(rng: () => number, users: User[]): SmartView[] {
  return SMART_VIEW_SEEDS.map((seed) => {
    // parse() both validates the DSL at build time and yields a real AST.
    const ast = parse(seed.dsl) as unknown as Record<string, unknown>;
    return {
      id: uuidFrom(rng),
      name: seed.name,
      ownerId: seed.shared ? null : pick(rng, users).id,
      shared: seed.shared,
      dsl: seed.dsl,
      ast,
      sort: { field: 'last_contacted', dir: 'desc' },
      columns: ['name', 'status', 'owner', 'last_contacted', 'next_task_due'],
      createdAt: daysAgo(int(rng, 20, 200)),
      updatedAt: daysAgo(int(rng, 0, 10)),
    };
  });
}

function buildSearchIndex(leads: Lead[], contacts: Contact[], statuses: LeadStatus[]): SearchHit[] {
  const statusById = new Map(statuses.map((s) => [s.id, s.label]));
  const hits: SearchHit[] = [];
  for (const lead of leads) {
    hits.push({
      kind: 'lead',
      id: lead.id,
      leadId: lead.id,
      title: lead.name,
      subtitle: (lead.statusId && statusById.get(lead.statusId)) || 'Lead',
    });
  }
  const leadName = new Map(leads.map((l) => [l.id, l.name]));
  for (const contact of contacts) {
    hits.push({
      kind: 'contact',
      id: contact.id,
      leadId: contact.leadId,
      title: contact.name,
      subtitle: leadName.get(contact.leadId) ?? 'Contact',
    });
  }
  return hits;
}

/** The single, deterministic in-memory database backing every MSW handler. */
export const db: MockDb = buildDb();
