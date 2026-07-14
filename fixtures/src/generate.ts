import { createHash } from 'node:crypto';
import { Rng } from './rng.ts';
import type {
  ActivityRecord,
  ContactRecord,
  Dataset,
  DatasetCounts,
  LeadBundle,
  LeadRecord,
  OpportunityRecord,
  TaskRecord,
} from './types.ts';

// --- Deterministic dataset descriptors ------------------------------------

export const GOLDEN = { seed: 'switchboard-golden-v1', count: 5000 } as const;
export const LATENCY = { seed: 'switchboard-latency-v1', count: 100_000 } as const;

/** Fixed clock so timestamps are reproducible (never `Date.now()`). */
const REFERENCE_MS = Date.parse('2026-06-01T00:00:00.000Z');
const DAY_MS = 86_400_000;

// --- Static pools ----------------------------------------------------------

const OWNER_IDS: readonly string[] = (() => {
  const r = new Rng('switchboard-owners-v1');
  return Array.from({ length: 8 }, () => r.uuid());
})();

const STATUSES = ['Potential', 'Contacted', 'Qualified', 'Won', 'Lost'] as const;
const STATUS_WEIGHTS = [30, 30, 20, 10, 10] as const;

const OPP_STAGES = ['Discovery', 'Proposal', 'Negotiation', 'Closed'] as const;
const INDUSTRIES = ['saas', 'fintech', 'healthcare', 'retail', 'manufacturing', 'media'] as const;
const TIERS = ['smb', 'mid_market', 'enterprise'] as const;
const CONTACT_TITLES = ['CEO', 'VP Sales', 'Head of Ops', 'Engineer', 'Buyer', 'CFO'] as const;

const FIRST_NAMES = [
  'Ava',
  'Liam',
  'Mia',
  'Noah',
  'Emma',
  'Ethan',
  'Olivia',
  'Lucas',
  'Sofia',
  'Mason',
  'Isla',
  'Leo',
  'Nora',
  'Kai',
  'Zoe',
  'Ivan',
] as const;
const LAST_NAMES = [
  'Reyes',
  'Novak',
  'Okafor',
  'Costa',
  'Haas',
  'Bauer',
  'Singh',
  'Moreno',
  'Petrov',
  'Yamada',
  'Khan',
  'Diaz',
  'Lund',
  'Fischer',
  'Abbas',
  'Nash',
] as const;
const COMPANY_ROOTS = [
  'Northwind',
  'Acme',
  'Globex',
  'Initech',
  'Umbrella',
  'Hooli',
  'Stark',
  'Wayne',
  'Cyberdyne',
  'Soylent',
  'Vandelay',
  'Wonka',
  'Tyrell',
  'Massive',
  'Pied',
  'Aperture',
] as const;
const COMPANY_SUFFIX = ['Labs', 'Systems', 'Group', 'Digital', 'Co', 'Networks'] as const;

// Activity types that participate in DSL activity predicates / denormalized cols.
const ACTIVITY_POOL = [
  'call_logged',
  'call_missed',
  'voicemail_received',
  'email_sent',
  'email_received',
  'sms_sent',
  'sms_received',
  'note_added',
  'task_completed',
  'status_changed',
  'sequence_step_sent',
  'sequence_enrolled',
] as const;
const ACTIVITY_WEIGHTS = [12, 4, 3, 20, 14, 8, 6, 10, 8, 5, 6, 4] as const;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function maxIso(candidates: readonly string[]): string | null {
  let best: string | null = null;
  for (const c of candidates) {
    if (best === null || c > best) {
      best = c;
    }
  }
  return best;
}

// --- Per-lead generation ---------------------------------------------------

function buildLeadBundle(r: Rng, index: number): LeadBundle {
  const leadId = r.uuid();
  const ownerId = r.pick(OWNER_IDS);
  const root = r.pick(COMPANY_ROOTS);
  const suffix = r.pick(COMPANY_SUFFIX);
  const companyName = `${root} ${suffix}`;
  const domain = `${root.toLowerCase()}${index}.example.com`;
  const status = r.weighted(STATUSES, STATUS_WEIGHTS);
  const createdMs = REFERENCE_MS - r.int(1, 720) * DAY_MS;

  const custom: Record<string, string | number | boolean> = {
    industry: r.pick(INDUSTRIES),
    tier: r.pick(TIERS),
    employees: r.int(1, 5000),
    is_target: r.bool(0.25),
  };

  // Contacts: 1..3
  const contactCount = r.int(1, 3);
  const contacts: ContactRecord[] = [];
  for (let c = 0; c < contactCount; c++) {
    const first = r.pick(FIRST_NAMES);
    const last = r.pick(LAST_NAMES);
    contacts.push({
      id: r.uuid(),
      leadId,
      name: `${first} ${last}`,
      title: r.pick(CONTACT_TITLES),
      emails: [{ email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`, type: 'work' }],
      phones: [{ phone: `+1${r.int(200, 989)}${r.int(1000000, 9999999)}`, type: 'mobile' }],
      dnc: r.bool(0.03),
    });
  }
  const primaryContactId = contacts[0]?.id ?? null;

  // Opportunities: ~40% of leads have one.
  const opportunities: OpportunityRecord[] = [];
  if (r.bool(0.4)) {
    const oppStatus: OpportunityRecord['status'] =
      status === 'Won' ? 'won' : status === 'Lost' ? 'lost' : 'active';
    opportunities.push({
      id: r.uuid(),
      leadId,
      contactId: primaryContactId,
      valueCents: r.int(50, 50000) * 100,
      currency: 'USD',
      stage: r.pick(OPP_STAGES),
      confidence: r.int(0, 100),
      closeDate: iso(REFERENCE_MS + r.int(-60, 120) * DAY_MS).slice(0, 10),
      ownerId,
      status: oppStatus,
      note: `${companyName} opportunity`,
    });
  }

  // Activities: 0..25, spread over the last 180 days.
  const activityCount = r.int(0, 25);
  const activities: ActivityRecord[] = [];
  for (let a = 0; a < activityCount; a++) {
    const type = r.weighted(ACTIVITY_POOL, ACTIVITY_WEIGHTS);
    const occurredMs = REFERENCE_MS - r.int(0, 180) * DAY_MS - r.int(0, DAY_MS);
    activities.push({
      id: r.uuid(),
      leadId,
      contactId: r.bool(0.6) ? primaryContactId : null,
      userId: r.bool(0.8) ? ownerId : null,
      type,
      occurredAt: iso(occurredMs),
      payload: { channel: type.split('_')[0] ?? 'system' },
    });
  }

  // Tasks: ~30% have one open task → drives next_task_due_at.
  const tasks: TaskRecord[] = [];
  let nextTaskDueAt: string | null = null;
  if (r.bool(0.3)) {
    const dueAt = iso(REFERENCE_MS + r.int(-10, 30) * DAY_MS);
    nextTaskDueAt = dueAt;
    tasks.push({
      id: r.uuid(),
      leadId,
      assigneeId: ownerId,
      title: r.pick(['Follow up', 'Send proposal', 'Book demo', 'Check in']),
      dueAt,
      completedAt: null,
    });
  }

  // Denormalized hot columns (CONTRACTS §C1) derived from the activities above.
  const at = (types: readonly string[]): string | null =>
    maxIso(activities.filter((x) => types.includes(x.type)).map((x) => x.occurredAt));

  const lead: LeadRecord = {
    id: leadId,
    name: companyName,
    url: `https://${domain}`,
    description: `${companyName} — ${custom.industry} (${custom.tier})`,
    status,
    ownerId,
    custom,
    dnc: r.bool(0.02),
    lastContactedAt: at(['call_logged', 'email_sent', 'sms_sent', 'sequence_step_sent']),
    lastInboundAt: at(['email_received', 'sms_received']),
    nextTaskDueAt,
    lastCallAt: at(['call_logged', 'call_missed', 'voicemail_received']),
    lastEmailAt: at(['email_sent', 'email_received']),
    lastSmsAt: at(['sms_sent', 'sms_received']),
    createdAt: iso(createdMs),
  };

  return { lead, contacts, opportunities, tasks, activities };
}

/**
 * Streams lead bundles for `count` leads from `seed`. Consumed both by the
 * in-memory `generateDataset` (golden) and the ndjson streaming path (latency),
 * so both share one deterministic generation order.
 */
export function* generateLeadBundles(count: number, seed: string): Generator<LeadBundle> {
  const r = new Rng(seed);
  for (let i = 0; i < count; i++) {
    yield buildLeadBundle(r, i);
  }
}

/** Materialises a full dataset in memory (used for golden + tests). */
export function generateDataset(count: number, seed: string): Dataset {
  const dataset: Dataset = {
    leads: [],
    contacts: [],
    opportunities: [],
    tasks: [],
    activities: [],
  };
  for (const bundle of generateLeadBundles(count, seed)) {
    dataset.leads.push(bundle.lead);
    dataset.contacts.push(...bundle.contacts);
    dataset.opportunities.push(...bundle.opportunities);
    dataset.tasks.push(...bundle.tasks);
    dataset.activities.push(...bundle.activities);
  }
  return dataset;
}

export function countDataset(dataset: Dataset): DatasetCounts {
  return {
    leads: dataset.leads.length,
    contacts: dataset.contacts.length,
    opportunities: dataset.opportunities.length,
    tasks: dataset.tasks.length,
    activities: dataset.activities.length,
  };
}

/** Stable SHA-256 over the whole dataset — the determinism fingerprint. */
export function datasetHash(dataset: Dataset): string {
  return createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
}
