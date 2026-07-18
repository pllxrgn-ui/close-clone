import { describe, expect, test } from 'vitest';
import { buildPlan, type ExistingIndex, type PlanContext } from './planner.ts';
import { parseCsvRecords } from './csv.ts';
import { defaultDedupeConfig, type DedupeConfig, type ImportMapping } from '../types.ts';

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    customFields: new Map([['employees', { key: 'employees', type: 'number', options: null }]]),
    statusByLabel: new Map([['qualified', 'status-q']]),
    userByEmail: new Map([['ben@switchboard.test', 'user-ben']]),
    userById: new Set(['user-ben']),
    ...over,
  };
}

const NO_MATCH: ExistingIndex = {
  matchByEmail: () => null,
  matchByDomain: () => null,
  matchByName: () => null,
  isSuppressed: () => false,
};

let seq = 0;
function ids(): { newLeadId: () => string; newContactId: () => string } {
  return {
    newLeadId: () => `lead-${(seq += 1)}`,
    newContactId: () => `contact-${(seq += 1)}`,
  };
}

interface Opts {
  mapping: ImportMapping;
  csv: string;
  dedupe?: DedupeConfig;
  existing?: ExistingIndex;
  context?: PlanContext;
}
function plan(o: Opts) {
  return buildPlan({
    records: parseCsvRecords(o.csv),
    mapping: o.mapping,
    dedupe: o.dedupe ?? defaultDedupeConfig(),
    ctx: o.context ?? ctx(),
    existing: o.existing ?? NO_MATCH,
    ...ids(),
  });
}

const COMPANY_EMAIL: ImportMapping = {
  columns: [
    { source: 'Company', target: 'lead.name' },
    { source: 'Website', target: 'lead.url' },
    { source: 'Email', target: 'contact.email' },
  ],
};

describe('buildPlan — creates', () => {
  test('creates a lead + contact for each fresh row', () => {
    const p = plan({
      mapping: COMPANY_EMAIL,
      csv: 'Company,Website,Email\nMarlowe Textiles,marlowe.example.com,a@marlowe.example.com\nKestrel,kestrel.example.com,b@kestrel.example.com',
    });
    expect(p.counts.totalRows).toBe(2);
    expect(p.counts.leadsCreated).toBe(2);
    expect(p.counts.contactsCreated).toBe(2);
    expect(p.rows.every((r) => r.outcome === 'create')).toBe(true);
    expect(p.rows[0]?.rowIndex).toBe(1);
  });
});

describe('buildPlan — empty + error rows', () => {
  test('counts a blank line as empty', () => {
    const p = plan({
      mapping: COMPANY_EMAIL,
      csv: 'Company,Website,Email\n\nAcme,acme.example.com,a@acme.example.com',
    });
    expect(p.counts.emptyRows).toBe(1);
    expect(p.rows[0]?.outcome).toBe('empty');
  });

  test('flags a malformed email as an error row (invalid_email)', () => {
    const p = plan({
      mapping: COMPANY_EMAIL,
      csv: 'Company,Website,Email\nAcme,acme.example.com,not-an-email',
    });
    expect(p.counts.errorRows).toBe(1);
    const row = p.rows[0];
    expect(row?.outcome).toBe('error');
    expect(row?.errors[0]?.code).toBe('invalid_email');
  });

  test('errors when a row has no lead name and no dedupe match', () => {
    const p = plan({
      mapping: COMPANY_EMAIL,
      csv: 'Company,Website,Email\n,,orphan@nowhere.example.com',
    });
    expect(p.counts.errorRows).toBe(1);
    expect(p.rows[0]?.errors[0]?.code).toBe('missing_lead_name');
  });

  test('coerces a custom number field and errors on a non-number', () => {
    const mapping: ImportMapping = {
      columns: [
        { source: 'Company', target: 'lead.name' },
        { source: 'Headcount', target: 'custom.employees' },
      ],
    };
    const p = plan({ mapping, csv: 'Company,Headcount\nAcme,not-a-number' });
    expect(p.rows[0]?.outcome).toBe('error');
    expect(p.rows[0]?.errors[0]?.code).toBe('invalid_number');
  });
});

describe('buildPlan — dedupe', () => {
  const dupCsv =
    'Company,Website,Email\nMarlowe,marlowe.example.com,a@marlowe.example.com\nMarlowe,marlowe.example.com,a@marlowe.example.com';

  test('skips an in-file duplicate (default action)', () => {
    const p = plan({ mapping: COMPANY_EMAIL, csv: dupCsv });
    expect(p.counts.leadsCreated).toBe(1);
    expect(p.counts.dedupeSkipped).toBe(1);
    expect(p.rows[1]?.outcome).toBe('dedupe');
    expect(p.rows[1]?.action).toBe('skip');
  });

  test('skips a row matching an existing contact email', () => {
    const existing: ExistingIndex = {
      ...NO_MATCH,
      matchByEmail: (e) => (e === 'a@marlowe.example.com' ? 'existing-lead' : null),
    };
    const p = plan({
      mapping: COMPANY_EMAIL,
      csv: 'Company,Website,Email\nMarlowe,marlowe.example.com,a@marlowe.example.com',
      existing,
    });
    expect(p.counts.dedupeSkipped).toBe(1);
    expect(p.counts.matchedByEmail).toBe(1);
    expect(p.rows[0]?.targetLeadId).toBe('existing-lead');
    expect(p.rows[0]?.matchType).toBe('email');
  });

  test('merge-fields attaches a contact to a domain-matched existing lead', () => {
    const existing: ExistingIndex = {
      ...NO_MATCH,
      matchByDomain: (d) => (d === 'marlowe.example.com' ? 'existing-lead' : null),
    };
    const p = plan({
      mapping: COMPANY_EMAIL,
      csv: 'Company,Website,Email\nMarlowe,marlowe.example.com,new@marlowe.example.com',
      existing,
      dedupe: { ...defaultDedupeConfig(), action: 'merge-fields' },
    });
    expect(p.counts.dedupeMerged).toBe(1);
    expect(p.counts.contactsCreated).toBe(1);
    expect(p.rows[0]?.outcome).toBe('dedupe');
    expect(p.rows[0]?.action).toBe('merge-fields');
    expect(p.rows[0]?.targetLeadId).toBe('existing-lead');
  });

  test('create-anyway makes a new lead despite an existing match', () => {
    const existing: ExistingIndex = {
      ...NO_MATCH,
      matchByDomain: () => 'existing-lead',
    };
    const p = plan({
      mapping: COMPANY_EMAIL,
      csv: 'Company,Website,Email\nMarlowe,marlowe.example.com,a@marlowe.example.com',
      existing,
      dedupe: { ...defaultDedupeConfig(), action: 'create-anyway' },
    });
    expect(p.counts.leadsCreated).toBe(1);
    expect(p.counts.dedupeCreateAnyway).toBe(1);
    expect(p.rows[0]?.outcome).toBe('create');
  });

  test('respects the domain toggle being off', () => {
    const existing: ExistingIndex = { ...NO_MATCH, matchByDomain: () => 'existing-lead' };
    const p = plan({
      mapping: COMPANY_EMAIL,
      csv: 'Company,Website,Email\nMarlowe,marlowe.example.com,a@marlowe.example.com',
      existing,
      dedupe: {
        ...defaultDedupeConfig(),
        matchOn: { email: true, domain: false, fuzzyName: true },
      },
    });
    expect(p.counts.leadsCreated).toBe(1);
    expect(p.counts.dedupeSkipped).toBe(0);
  });
});

describe('buildPlan — suppression + warnings', () => {
  test('flags a created contact whose email is suppressed', () => {
    const existing: ExistingIndex = {
      ...NO_MATCH,
      isSuppressed: (e) => e === 'a@marlowe.example.com',
    };
    const p = plan({
      mapping: COMPANY_EMAIL,
      csv: 'Company,Website,Email\nMarlowe,marlowe.example.com,a@marlowe.example.com',
      existing,
    });
    expect(p.counts.suppressedContacts).toBe(1);
    expect(p.rows[0]?.contact?.suppressed).toBe(true);
    expect(p.rows[0]?.suppressedEmails).toEqual(['a@marlowe.example.com']);
  });

  test('warns about a duplicate header', () => {
    const p = plan({
      mapping: COMPANY_EMAIL,
      csv: 'Company,Company,Email\nAcme,Dup,a@acme.example.com',
    });
    expect(p.warnings.some((w) => w.toLowerCase().includes('duplicate'))).toBe(true);
  });
});
