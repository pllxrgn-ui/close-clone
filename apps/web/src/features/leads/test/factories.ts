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

/*
 * Test DTO factories — valid @switchboard/shared shapes with sensible defaults
 * and shallow overrides. Ids are deterministic (uuid-shaped) so keys and cursors
 * are stable across runs. Timestamps default to a fixed reference instant.
 */

let counter = 0;
export function uid(prefix = '0'): string {
  counter += 1;
  const n = counter.toString(16).padStart(12, '0');
  return `${prefix.padStart(8, '0')}-0000-4000-8000-${n}`;
}

const NOW = new Date('2026-07-15T17:00:00.000Z');
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
export const REF_NOW = NOW;
export const hoursAgo = (h: number): string => iso(-h * 3_600_000);
export const daysAgo = (d: number): string => iso(-d * 86_400_000);
export const daysAhead = (d: number): string => iso(d * 86_400_000);

export function makeUser(over: Partial<User> = {}): User {
  return {
    id: uid('11'),
    email: 'rep@switchboard.test',
    name: 'Ada Okafor',
    role: 'rep',
    idpSubject: 'dev|rep',
    isActive: true,
    timezone: 'America/New_York',
    createdAt: daysAgo(400),
    updatedAt: daysAgo(2),
    ...over,
  };
}

export function makeStatus(over: Partial<LeadStatus> = {}): LeadStatus {
  return {
    id: uid('22'),
    label: 'Qualified',
    sortOrder: 2,
    createdAt: daysAgo(400),
    updatedAt: daysAgo(400),
    ...over,
  };
}

export function makeStage(over: Partial<OpportunityStage> = {}): OpportunityStage {
  return {
    id: uid('23'),
    label: 'Proposal',
    sortOrder: 1,
    createdAt: daysAgo(400),
    updatedAt: daysAgo(400),
    ...over,
  };
}

export function makeLead(over: Partial<Lead> = {}): Lead {
  return {
    id: uid('33'),
    name: 'North Labs',
    url: 'https://north-labs.example.com',
    description: 'Mid-Market account in NA-East.',
    statusId: null,
    ownerId: null,
    custom: {},
    lastContactedAt: null,
    lastInboundAt: null,
    nextTaskDueAt: null,
    lastCallAt: null,
    lastEmailAt: null,
    lastSmsAt: null,
    dnc: false,
    deletedAt: null,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    ...over,
  };
}

export function makeContact(over: Partial<Contact> = {}): Contact {
  return {
    id: uid('44'),
    leadId: uid('33'),
    name: 'Sam Patel',
    title: 'VP Sales',
    emails: [{ email: 'sam.patel@north-labs.example.com', type: 'work' }],
    phones: [{ phone: '+12065550100', type: 'mobile' }],
    dnc: false,
    deletedAt: null,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    ...over,
  };
}

export function makeOpportunity(over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: uid('55'),
    leadId: uid('33'),
    contactId: null,
    valueCents: 5_000_000,
    currency: 'USD',
    stageId: null,
    confidence: 60,
    closeDate: daysAhead(30).slice(0, 10),
    ownerId: null,
    status: 'active',
    note: null,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    ...over,
  };
}

export function makeActivity(over: Partial<Activity> = {}): Activity {
  return {
    id: uid('66'),
    leadId: uid('33'),
    contactId: null,
    userId: null,
    type: 'note_added',
    occurredAt: hoursAgo(3),
    payload: {},
    createdAt: hoursAgo(3),
    updatedAt: hoursAgo(3),
    ...over,
  };
}

export function makeSmartView(over: Partial<SmartView> = {}): SmartView {
  return {
    id: uid('77'),
    name: 'My open leads',
    ownerId: null,
    shared: false,
    dsl: 'owner in (me)',
    ast: { type: 'membership', field: 'owner', values: ['me'] },
    sort: { field: 'last_contacted', dir: 'desc' },
    columns: ['name', 'status', 'owner', 'last_contacted', 'next_task_due'],
    createdAt: daysAgo(40),
    updatedAt: daysAgo(2),
    ...over,
  };
}
