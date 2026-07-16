import { describe, expect, test } from 'vitest';

import type { CsvRecord } from './csv.ts';
import type { ExistingIndex } from './dedupe.ts';
import type { MappingContext } from './mapping.ts';
import { buildPlan, type FuzzyResolver, type PlanDeps } from './plan.ts';
import { dedupeConfigSchema, type DedupeConfig, type ImportMapping } from './types.ts';

/**
 * Dry-run planner — pure unit tests (no DB). The existing-lead snapshot and the
 * batched fuzzy resolver are faked; `deriveDomains`/`normalizeName` run for real.
 * Covers every disposition, in-file dedupe, all three dedupe actions, suppression
 * flagging, error/empty rows, and the aggregate counts.
 */

const HEADERS = ['Company', 'Website', 'Email', 'Contact', 'Status'];

const MAPPING: ImportMapping = {
  columns: [
    { source: 'Company', target: 'lead.name' },
    { source: 'Website', target: 'lead.url' },
    { source: 'Email', target: 'contact.email' },
    { source: 'Contact', target: 'contact.name' },
    { source: 'Status', target: 'lead.status' },
  ],
};

const CTX: MappingContext = {
  customFields: new Map(),
  statusByLabel: new Map([['qualified', 's-qual']]),
  userByEmail: new Map(),
  userById: new Set(),
};

function recordsOf(rows: CsvRecord[]): AsyncIterable<CsvRecord> {
  return (async function* () {
    yield HEADERS;
    for (const r of rows) yield r;
  })();
}

function fakeIndex(opts: {
  emails?: Record<string, string>;
  domains?: Record<string, string>;
  suppressed?: string[];
}): ExistingIndex {
  const emails = new Map(Object.entries(opts.emails ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const domains = new Map(Object.entries(opts.domains ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const supp = new Set((opts.suppressed ?? []).map((s) => s.toLowerCase()));
  return {
    matchByEmail: (e) => emails.get(e.toLowerCase()) ?? null,
    matchByDomain: (d) => domains.get(d.toLowerCase()) ?? null,
    isSuppressed: (e) => supp.has(e.toLowerCase()),
    matchByFuzzyName: () => Promise.resolve(null),
  };
}

function fuzzyOf(preset: Record<string, string> = {}): FuzzyResolver {
  const map = new Map(Object.entries(preset).map(([k, v]) => [k.toLowerCase(), v]));
  return () => Promise.resolve(map);
}

function deps(overrides: Partial<PlanDeps> & { existing: ExistingIndex }): PlanDeps {
  let ln = 0;
  let cn = 0;
  const dedupe: DedupeConfig = overrides.dedupe ?? dedupeConfigSchema.parse({});
  return {
    mapping: MAPPING,
    dedupe,
    ctx: CTX,
    fuzzy: fuzzyOf(),
    newLeadId: () => `L${(ln += 1)}`,
    newContactId: () => `C${(cn += 1)}`,
    ...overrides,
  };
}

const cfg = (o: Partial<DedupeConfig>): DedupeConfig => dedupeConfigSchema.parse(o);

describe('buildPlan — clean creates', () => {
  test('rows with no match create a lead (+ contact) each', async () => {
    const plan = await buildPlan(
      recordsOf([
        ['Acme', 'https://acme.com', 'alice@acme.com', 'Alice', 'Qualified'],
        ['Globex', 'globex.io', 'bob@globex.io', 'Bob', ''],
      ]),
      deps({ existing: fakeIndex({}) }),
    );
    expect(plan.counts.leadsCreated).toBe(2);
    expect(plan.counts.contactsCreated).toBe(2);
    expect(plan.rows.map((r) => r.outcome)).toEqual(['create', 'create']);
    const first = plan.rows[0];
    expect(first?.lead?.name).toBe('Acme');
    expect(first?.lead?.statusId).toBe('s-qual');
    expect(first?.contact?.email).toBe('alice@acme.com');
    expect(first?.targetLeadId).toBe(first?.lead?.id);
  });

  test('a lead-only row creates a lead with no contact', async () => {
    const plan = await buildPlan(
      recordsOf([['Acme', 'https://acme.com', '', '', '']]),
      deps({ existing: fakeIndex({}) }),
    );
    expect(plan.counts.leadsCreated).toBe(1);
    expect(plan.counts.contactsCreated).toBe(0);
    expect(plan.rows[0]?.contact).toBeNull();
  });
});

describe('buildPlan — in-file dedupe (exact key)', () => {
  test('a second row with the same email dedupes against the first (skip)', async () => {
    const plan = await buildPlan(
      recordsOf([
        ['Acme', 'https://acme.com', 'alice@acme.com', 'Alice', ''],
        ['Acme Inc', '', 'alice@acme.com', 'Alice A', ''],
      ]),
      deps({ existing: fakeIndex({}) }),
    );
    expect(plan.rows[0]?.outcome).toBe('create');
    expect(plan.rows[1]?.outcome).toBe('dedupe');
    expect(plan.rows[1]?.matchType).toBe('email');
    expect(plan.rows[1]?.targetLeadId).toBe(plan.rows[0]?.targetLeadId);
    expect(plan.counts.leadsCreated).toBe(1);
    expect(plan.counts.dedupeSkipped).toBe(1);
  });

  test('a second row with the same company domain dedupes against the first', async () => {
    const plan = await buildPlan(
      recordsOf([
        ['Acme', 'https://acme.com', 'alice@acme.com', 'Alice', ''],
        ['Acme West', 'https://www.acme.com/west', 'carol@other.com', 'Carol', ''],
      ]),
      deps({ existing: fakeIndex({}) }),
    );
    expect(plan.rows[1]?.outcome).toBe('dedupe');
    expect(plan.rows[1]?.matchType).toBe('domain');
    expect(plan.counts.matchedByDomain).toBe(1);
  });
});

describe('buildPlan — existing-lead match + action', () => {
  const existing = fakeIndex({ emails: { 'alice@acme.com': 'EXIST-1' } });
  const row: CsvRecord = ['Acme', 'https://acme.com', 'alice@acme.com', 'Alice', ''];

  test('skip: matched row writes nothing', async () => {
    const plan = await buildPlan(recordsOf([row]), deps({ existing, dedupe: cfg({ action: 'skip' }) }));
    expect(plan.rows[0]?.outcome).toBe('dedupe');
    expect(plan.rows[0]?.action).toBe('skip');
    expect(plan.rows[0]?.targetLeadId).toBe('EXIST-1');
    expect(plan.counts).toMatchObject({ leadsCreated: 0, dedupeSkipped: 1, matchedByEmail: 1 });
  });

  test('create-anyway: matched row still creates a new lead', async () => {
    const plan = await buildPlan(
      recordsOf([row]),
      deps({ existing, dedupe: cfg({ action: 'create-anyway' }) }),
    );
    expect(plan.rows[0]?.outcome).toBe('create');
    expect(plan.rows[0]?.action).toBe('create-anyway');
    expect(plan.rows[0]?.matchType).toBe('email');
    expect(plan.rows[0]?.targetLeadId).not.toBe('EXIST-1');
    expect(plan.counts).toMatchObject({ leadsCreated: 1, dedupeCreateAnyway: 1, matchedByEmail: 1 });
  });

  test('merge-fields on an email match attaches to the lead WITHOUT a duplicate contact', async () => {
    const plan = await buildPlan(
      recordsOf([row]),
      deps({ existing, dedupe: cfg({ action: 'merge-fields' }) }),
    );
    expect(plan.rows[0]?.outcome).toBe('dedupe');
    expect(plan.rows[0]?.action).toBe('merge-fields');
    expect(plan.rows[0]?.targetLeadId).toBe('EXIST-1');
    expect(plan.rows[0]?.contactCreated).toBe(false); // email already on the lead
    expect(plan.rows[0]?.lead?.id).toBe('EXIST-1');
    expect(plan.counts).toMatchObject({ dedupeMerged: 1, contactsCreated: 0 });
  });

  test('merge-fields on a domain match DOES attach the new contact', async () => {
    const byDomain = fakeIndex({ domains: { 'acme.com': 'EXIST-9' } });
    const plan = await buildPlan(
      recordsOf([['Acme', 'https://acme.com', 'newperson@acme.com', 'New Person', '']]),
      deps({ existing: byDomain, dedupe: cfg({ action: 'merge-fields' }) }),
    );
    expect(plan.rows[0]?.matchType).toBe('domain');
    expect(plan.rows[0]?.contactCreated).toBe(true);
    expect(plan.rows[0]?.contact?.email).toBe('newperson@acme.com');
    expect(plan.counts.contactsCreated).toBe(1);
  });
});

describe('buildPlan — fuzzy name match', () => {
  test('uses the batched fuzzy resolver to match an existing lead', async () => {
    const plan = await buildPlan(
      recordsOf([['Acme Corporation', '', '', '', '']]),
      deps({
        existing: fakeIndex({}),
        fuzzy: fuzzyOf({ 'acme corporation': 'FUZZY-1' }),
        dedupe: cfg({ action: 'skip' }),
      }),
    );
    expect(plan.rows[0]?.outcome).toBe('dedupe');
    expect(plan.rows[0]?.matchType).toBe('fuzzy-name');
    expect(plan.rows[0]?.targetLeadId).toBe('FUZZY-1');
    expect(plan.counts.matchedByFuzzyName).toBe(1);
  });

  test('fuzzy matching is skipped when matchOn.fuzzyName is false', async () => {
    const plan = await buildPlan(
      recordsOf([['Acme Corporation', '', '', '', '']]),
      deps({
        existing: fakeIndex({}),
        fuzzy: fuzzyOf({ 'acme corporation': 'FUZZY-1' }),
        dedupe: cfg({ matchOn: { email: true, domain: true, fuzzyName: false } }),
      }),
    );
    expect(plan.rows[0]?.outcome).toBe('create');
  });
});

describe('buildPlan — suppression flagging', () => {
  test('a suppressed contact email is imported, flagged, and counted', async () => {
    const plan = await buildPlan(
      recordsOf([['Acme', 'https://acme.com', 'blocked@acme.com', 'Blocked', '']]),
      deps({ existing: fakeIndex({ suppressed: ['blocked@acme.com'] }) }),
    );
    expect(plan.rows[0]?.outcome).toBe('create');
    expect(plan.rows[0]?.contact?.suppressed).toBe(true);
    expect(plan.rows[0]?.suppressedEmails).toEqual(['blocked@acme.com']);
    expect(plan.counts.suppressedContacts).toBe(1);
    expect(plan.counts.contactsCreated).toBe(1); // still imported
  });
});

describe('buildPlan — errors and empties', () => {
  test('a row with an invalid cell is an error and imports nothing', async () => {
    const plan = await buildPlan(
      recordsOf([['Acme', '', 'not-an-email', 'X', 'Qualified']]),
      deps({ existing: fakeIndex({}) }),
    );
    expect(plan.rows[0]?.outcome).toBe('error');
    expect(plan.rows[0]?.errors.map((e) => e.code)).toContain('invalid_email');
    expect(plan.counts).toMatchObject({ errorRows: 1, leadsCreated: 0, contactsCreated: 0 });
  });

  test('a row with no lead name and no match is a missing_lead_name error', async () => {
    const plan = await buildPlan(
      recordsOf([['', '', 'ghost@nowhere.com', 'Ghost', '']]),
      deps({ existing: fakeIndex({}) }),
    );
    expect(plan.rows[0]?.outcome).toBe('error');
    expect(plan.rows[0]?.errors[0]?.code).toBe('missing_lead_name');
    expect(plan.counts.errorRows).toBe(1);
  });

  test('a nameless row that DOES match is not an error (attaches per action)', async () => {
    const plan = await buildPlan(
      recordsOf([['', '', 'alice@acme.com', 'Alice', '']]),
      deps({
        existing: fakeIndex({ emails: { 'alice@acme.com': 'EXIST-1' } }),
        dedupe: cfg({ action: 'skip' }),
      }),
    );
    expect(plan.rows[0]?.outcome).toBe('dedupe');
    expect(plan.counts.errorRows).toBe(0);
  });

  test('create-anyway with no lead name reverts the match count and errors', async () => {
    const plan = await buildPlan(
      recordsOf([['', '', 'alice@acme.com', 'Alice', '']]),
      deps({
        existing: fakeIndex({ emails: { 'alice@acme.com': 'EXIST-1' } }),
        dedupe: cfg({ action: 'create-anyway' }),
      }),
    );
    expect(plan.rows[0]?.outcome).toBe('error');
    expect(plan.counts).toMatchObject({ errorRows: 1, leadsCreated: 0, matchedByEmail: 0 });
  });

  test('blank rows are counted as empty, not errors', async () => {
    const plan = await buildPlan(
      recordsOf([['', '', '', '', ''], ['Acme', '', '', '', '']]),
      deps({ existing: fakeIndex({}) }),
    );
    expect(plan.rows[0]?.outcome).toBe('empty');
    expect(plan.counts.emptyRows).toBe(1);
    expect(plan.counts.totalRows).toBe(2);
    expect(plan.counts.leadsCreated).toBe(1);
  });
});

describe('buildPlan — header warnings', () => {
  test('reports duplicate headers and mapped headers missing from the file', async () => {
    const records = (async function* () {
      yield ['Company', 'Company', 'Email'];
      yield ['Acme', 'Dup', 'a@acme.com'];
    })();
    const plan = await buildPlan(records, deps({ existing: fakeIndex({}) }));
    expect(plan.warnings.some((w) => w.includes('duplicate header "Company"'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('Website'))).toBe(true); // mapped, not in file
  });

  test('an empty file yields an empty plan with a warning', async () => {
    const empty = (async function* () {
      // no records at all
    })();
    const plan = await buildPlan(empty, deps({ existing: fakeIndex({}) }));
    expect(plan.rows).toEqual([]);
    expect(plan.counts.totalRows).toBe(0);
    expect(plan.warnings).toContain('file has no header row');
  });
});
