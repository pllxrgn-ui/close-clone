/*
 * In-memory admin store — the demo data layer for the settings + bulk surfaces.
 * Module-scope, seeded deterministically from the shared fixtures (read-only), so
 * writes survive route changes (not reloads) and lists/counts visibly change, per
 * the demo-functional rule. Shapes are the @switchboard/shared C1/C7 DTOs.
 *
 * Only THIS feature mutates these arrays; the shared `mocks/fixtures.ts` `db` is
 * imported read-only for user ids (template owners) and is mutated for leads ONLY
 * through the C7 `PATCH /leads/:id` handler in adminHandlers.ts.
 *
 * `resetAdminStore()` rebuilds every seed so colocated tests start from a known
 * state (module state persists across tests within a file otherwise).
 */
import type { OrgSettings, Snippet, Template, User } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import type { CustomFieldRow, SequenceWithCount } from '../types.ts';

const FIXED_NOW = '2026-07-15T17:00:00.000Z';

function ownerIds(): { admin: string | null; reps: string[] } {
  const users: User[] = db.users;
  const admin = users.find((u) => u.role === 'admin')?.id ?? null;
  const reps = users.filter((u) => u.role === 'rep').map((u) => u.id);
  return { admin, reps };
}

// ── Seeds (functions so resetAdminStore rebuilds fresh, unshared instances) ────

function seedCustomFields(): CustomFieldRow[] {
  return [
    {
      id: 'cf-lead-segment',
      entity: 'lead',
      key: 'segment',
      label: 'Segment',
      type: 'select',
      options: ['SMB', 'Mid-Market', 'Enterprise'],
      required: false,
    },
    {
      id: 'cf-lead-region',
      entity: 'lead',
      key: 'region',
      label: 'Region',
      type: 'select',
      options: ['NA-East', 'NA-West', 'EMEA', 'APAC', 'LATAM'],
      required: false,
    },
    {
      id: 'cf-lead-employees',
      entity: 'lead',
      key: 'employees',
      label: 'Employees',
      type: 'number',
      options: null,
      required: false,
    },
    {
      id: 'cf-lead-renewal',
      entity: 'lead',
      key: 'renewal_date',
      label: 'Renewal date',
      type: 'date',
      options: null,
      required: false,
    },
    {
      id: 'cf-lead-champion',
      entity: 'lead',
      key: 'champion',
      label: 'Champion',
      type: 'user',
      options: null,
      required: false,
    },
    {
      id: 'cf-lead-notes',
      entity: 'lead',
      key: 'notes',
      label: 'Account notes',
      type: 'text',
      options: null,
      required: false,
    },
    {
      id: 'cf-contact-persona',
      entity: 'contact',
      key: 'persona',
      label: 'Persona',
      type: 'select',
      options: ['Champion', 'Blocker', 'Economic buyer'],
      required: false,
    },
    {
      id: 'cf-opp-forecast',
      entity: 'opportunity',
      key: 'forecast_category',
      label: 'Forecast category',
      type: 'select',
      options: ['Commit', 'Best case', 'Pipeline'],
      required: false,
    },
  ];
}

function seedTemplates(): Template[] {
  const { admin, reps } = ownerIds();
  const rep0 = reps[0] ?? null;
  const base = (
    over: Partial<Template> & Pick<Template, 'id' | 'name' | 'channel' | 'body'>,
  ): Template => ({
    subject: null,
    ownerId: null,
    shared: true,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...over,
  });
  return [
    base({
      id: 'tpl-intro',
      name: 'Intro — first touch',
      channel: 'email',
      subject: 'Quick question about {{lead.name}}',
      body: 'Hi {{contact.firstName}},\n\nI work with revenue teams like {{lead.name}} on shortening the path from first call to signed deal. Worth a 15-minute look next week?\n\n— {{user.name}}',
      ownerId: admin,
    }),
    base({
      id: 'tpl-followup',
      name: 'Follow-up — no reply',
      channel: 'email',
      subject: 'Re: Quick question about {{lead.name}}',
      body: 'Hi {{contact.firstName}},\n\nFloating this back to the top of your inbox. Happy to send a short async walkthrough instead of a call if that is easier.\n\n— {{user.name}}',
      ownerId: admin,
    }),
    base({
      id: 'tpl-recap',
      name: 'Meeting recap',
      channel: 'email',
      subject: 'Recap + next steps',
      body: 'Thanks for the time today. To recap what we agreed:\n\n1. \n2. \n\nNext step is with you by {{date.nextWeek}}. Anything I missed?',
      ownerId: rep0,
    }),
    base({
      id: 'tpl-renewal',
      name: 'Renewal outreach',
      channel: 'email',
      subject: '{{lead.name}} renewal — {{custom.renewal_date}}',
      body: 'Hi {{contact.firstName}},\n\nYour renewal lands {{custom.renewal_date}}. I pulled usage for the quarter so we can right-size the plan before then. When works?',
      ownerId: admin,
    }),
    base({
      id: 'tpl-sms-reminder',
      name: 'Call reminder (SMS)',
      channel: 'sms',
      subject: null,
      body: 'Hi {{contact.firstName}}, confirming our call at {{task.dueTime}}. Reply STOP to opt out.',
      ownerId: rep0,
      shared: false,
    }),
  ];
}

function seedSnippets(): Snippet[] {
  const { admin } = ownerIds();
  const mk = (id: string, shortcut: string, body: string): Snippet => ({
    id,
    shortcut,
    body,
    ownerId: admin,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  });
  return [
    mk(
      'snp-calendly',
      '/book',
      'Grab any open slot here: https://cal.switchboard.test/{{user.handle}} — it drops straight onto my calendar.',
    ),
    mk(
      'snp-pricing',
      '/pricing',
      'Pricing scales by seat with volume breaks at 25 and 100. Happy to put concrete numbers against your team size on a call.',
    ),
    mk(
      'snp-thanks',
      '/thanks',
      'Appreciate you — I know inboxes are brutal. I will keep this short next time.',
    ),
    mk(
      'snp-security',
      '/security',
      'SOC 2 Type II, data encrypted at rest and in transit, SSO on every plan. Full report + DPA available under NDA.',
    ),
  ];
}

function seedOrgSettings(): OrgSettings {
  // recordingEnabledBy / recordingLegalSignoffRef stay null until legal sign-off
  // is recorded — the audit story the compliance section renders (display-only).
  return {
    id: 'org-settings-singleton',
    recordingEnabled: false,
    recordingEnabledBy: null,
    recordingLegalSignoffRef: null,
    quietHours: { start: '08:00', end: '21:00', tz: 'recipient-local' },
    sendingWindow: { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] },
    dailySendCap: 200,
    companyTimezone: 'America/New_York',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function seedSequences(): SequenceWithCount[] {
  return [
    { id: 'seq-onboarding', name: 'Onboarding', status: 'active', activeEnrollments: 42 },
    {
      id: 'seq-outbound-ent',
      name: 'Outbound — Enterprise',
      status: 'active',
      activeEnrollments: 17,
    },
    { id: 'seq-reengage', name: 'Re-engagement', status: 'active', activeEnrollments: 9 },
    { id: 'seq-trial', name: 'Trial nurture', status: 'active', activeEnrollments: 63 },
    { id: 'seq-winback-2024', name: 'Win-back 2024', status: 'archived', activeEnrollments: 0 },
  ];
}

// ── The mutable store ─────────────────────────────────────────────────────────

export interface AdminStore {
  customFields: CustomFieldRow[];
  templates: Template[];
  snippets: Snippet[];
  orgSettings: OrgSettings;
  sequences: SequenceWithCount[];
}

function build(): AdminStore {
  return {
    customFields: seedCustomFields(),
    templates: seedTemplates(),
    snippets: seedSnippets(),
    orgSettings: seedOrgSettings(),
    sequences: seedSequences(),
  };
}

/** The single admin store instance every admin MSW handler reads and writes. */
export const adminStore: AdminStore = build();

/** Rebuild every seed in place (tests call this in beforeEach for isolation). */
export function resetAdminStore(): void {
  const fresh = build();
  adminStore.customFields = fresh.customFields;
  adminStore.templates = fresh.templates;
  adminStore.snippets = fresh.snippets;
  adminStore.orgSettings = fresh.orgSettings;
  adminStore.sequences = fresh.sequences;
}
