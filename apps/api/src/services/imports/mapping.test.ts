import { describe, expect, test } from 'vitest';

import {
  buildHeaderIndex,
  mapRecord,
  parseTarget,
  validateMappingTargets,
  type MappingContext,
} from './mapping.ts';
import type { ImportMapping } from './types.ts';

const ctx: MappingContext = {
  customFields: new Map([
    ['industry', { key: 'industry', type: 'text', options: null }],
    ['employees', { key: 'employees', type: 'number', options: null }],
    ['signed_at', { key: 'signed_at', type: 'date', options: null }],
    ['tier', { key: 'tier', type: 'select', options: ['Gold', 'Silver', 'Bronze'] }],
    ['csm', { key: 'csm', type: 'user', options: null }],
  ]),
  statusByLabel: new Map([
    ['potential', 's-pot'],
    ['qualified', 's-qual'],
  ]),
  userByEmail: new Map([['rep@x.com', 'u-rep']]),
  userById: new Set(['u-rep']),
};

function mapping(cols: [string, string][]): ImportMapping {
  return { columns: cols.map(([source, target]) => ({ source, target })) };
}

describe('parseTarget', () => {
  test('parses each target form', () => {
    expect(parseTarget('ignore')).toEqual({ kind: 'ignore' });
    expect(parseTarget('lead.name')).toEqual({ kind: 'lead', field: 'name' });
    expect(parseTarget('contact.email')).toEqual({ kind: 'contact', field: 'email' });
    expect(parseTarget('custom.industry')).toEqual({ kind: 'custom', key: 'industry' });
  });

  test('rejects unknown builtins and malformed targets', () => {
    expect(parseTarget('lead.bogus')).toBeNull();
    expect(parseTarget('contact.bogus')).toBeNull();
    expect(parseTarget('widget.name')).toBeNull();
    expect(parseTarget('custom.')).toBeNull();
    expect(parseTarget('')).toBeNull();
  });
});

describe('validateMappingTargets', () => {
  test('flags invalid target syntax and unknown custom keys', () => {
    const errs = validateMappingTargets(
      mapping([
        ['Company', 'lead.name'],
        ['X', 'lead.bogus'],
        ['Y', 'custom.unknown_key'],
      ]),
      ctx,
    );
    expect(errs).toHaveLength(2);
    expect(errs.some((e) => e.includes('lead.bogus'))).toBe(true);
    expect(errs.some((e) => e.includes('unknown_key'))).toBe(true);
  });

  test('accepts a fully valid mapping', () => {
    expect(
      validateMappingTargets(
        mapping([
          ['Company', 'lead.name'],
          ['Employees', 'custom.employees'],
        ]),
        ctx,
      ),
    ).toEqual([]);
  });
});

describe('buildHeaderIndex', () => {
  test('maps headers to indices, first occurrence wins on duplicates', () => {
    const { index, duplicates } = buildHeaderIndex(['A', 'B', 'A', 'C']);
    expect(index.get('A')).toBe(0);
    expect(index.get('B')).toBe(1);
    expect(index.get('C')).toBe(3);
    expect(duplicates).toEqual(['A']);
  });

  test('trims header whitespace', () => {
    const { index } = buildHeaderIndex([' Name ', 'Email']);
    expect(index.get('Name')).toBe(0);
  });
});

describe('mapRecord — builtins', () => {
  const headers = ['Company', 'Website', 'Status', 'Owner', 'Full Name', 'Email', 'DNC'];
  const { index } = buildHeaderIndex(headers);
  const m = mapping([
    ['Company', 'lead.name'],
    ['Website', 'lead.url'],
    ['Status', 'lead.status'],
    ['Owner', 'lead.owner'],
    ['Full Name', 'contact.name'],
    ['Email', 'contact.email'],
    ['DNC', 'lead.dnc'],
  ]);

  test('maps a clean row', () => {
    const r = mapRecord(
      ['Acme', 'https://acme.com', 'Qualified', 'rep@x.com', 'Alice', 'alice@acme.com', 'true'],
      index,
      m,
      ctx,
    );
    expect(r.errors).toEqual([]);
    expect(r.lead.name).toBe('Acme');
    expect(r.lead.url).toBe('https://acme.com');
    expect(r.lead.statusId).toBe('s-qual');
    expect(r.lead.ownerId).toBe('u-rep');
    expect(r.lead.dnc).toBe(true);
    expect(r.contact.name).toBe('Alice');
    expect(r.contact.email).toBe('alice@acme.com');
  });

  test('empty cells become null, not errors', () => {
    const r = mapRecord(['Acme', '', '', '', '', '', ''], index, m, ctx);
    expect(r.errors).toEqual([]);
    expect(r.lead.url).toBeNull();
    expect(r.lead.statusId).toBeNull();
    expect(r.lead.ownerId).toBeNull();
    expect(r.lead.dnc).toBeNull();
    expect(r.contact.email).toBeNull();
  });

  test('unknown status + unknown owner + bad email + bad dnc collect as errors', () => {
    const r = mapRecord(
      ['Acme', 'x', 'Nonsense', 'ghost@x.com', 'Al', 'not-an-email', 'maybe'],
      index,
      m,
      ctx,
    );
    const codes = r.errors.map((e) => e.code).sort();
    expect(codes).toEqual(['invalid_bool', 'invalid_email', 'unknown_status', 'unknown_user']);
    // Company still mapped despite sibling-cell errors (nothing silently dropped).
    expect(r.lead.name).toBe('Acme');
  });

  test('lowercases email and resolves status case-insensitively', () => {
    const r = mapRecord(
      ['Acme', '', 'POTENTIAL', 'rep@x.com', 'A', 'Alice@ACME.com', 'no'],
      index,
      m,
      ctx,
    );
    expect(r.errors).toEqual([]);
    expect(r.lead.statusId).toBe('s-pot');
    expect(r.contact.email).toBe('alice@acme.com');
    expect(r.lead.dnc).toBe(false);
  });
});

describe('mapRecord — custom fields (typed per custom_field_defs)', () => {
  const headers = ['Industry', 'Emp', 'Signed', 'Tier', 'CSM'];
  const { index } = buildHeaderIndex(headers);
  const m = mapping([
    ['Industry', 'custom.industry'],
    ['Emp', 'custom.employees'],
    ['Signed', 'custom.signed_at'],
    ['Tier', 'custom.tier'],
    ['CSM', 'custom.csm'],
  ]);

  test('coerces valid typed values', () => {
    const r = mapRecord(['SaaS', '250', '2025-01-31', 'gold', 'rep@x.com'], index, m, ctx);
    expect(r.errors).toEqual([]);
    expect(r.lead.custom).toEqual({
      industry: 'SaaS',
      employees: 250,
      signed_at: '2025-01-31',
      tier: 'Gold',
      csm: 'u-rep',
    });
  });

  test('accepts ISO datetime for a date field, normalising to the calendar date', () => {
    const r = mapRecord(['', '', '2025-01-31T12:30:00Z', '', ''], index, m, ctx);
    expect(r.errors).toEqual([]);
    expect(r.lead.custom['signed_at']).toBe('2025-01-31');
  });

  test('collects each invalid typed cell as an error and omits it from custom', () => {
    const r = mapRecord(['SaaS', 'lots', '01/31/2025', 'Platinum', 'ghost@x.com'], index, m, ctx);
    const byTarget = Object.fromEntries(r.errors.map((e) => [e.target, e.code]));
    expect(byTarget).toEqual({
      'custom.employees': 'invalid_number',
      'custom.signed_at': 'invalid_date',
      'custom.tier': 'not_in_options',
      'custom.csm': 'unknown_user',
    });
    // Only the valid cell survives.
    expect(r.lead.custom).toEqual({ industry: 'SaaS' });
  });

  test('empty custom cells are skipped without error', () => {
    const r = mapRecord(['', '', '', '', ''], index, m, ctx);
    expect(r.errors).toEqual([]);
    expect(r.lead.custom).toEqual({});
  });
});

describe('mapRecord — ragged rows', () => {
  test('a short row treats missing trailing columns as empty', () => {
    const headers = ['Company', 'Email'];
    const { index } = buildHeaderIndex(headers);
    const m = mapping([
      ['Company', 'lead.name'],
      ['Email', 'contact.email'],
    ]);
    const r = mapRecord(['Acme'], index, m, ctx);
    expect(r.errors).toEqual([]);
    expect(r.lead.name).toBe('Acme');
    expect(r.contact.email).toBeNull();
  });

  test('a mapping to a header absent from the file is ignored', () => {
    const headers = ['Company'];
    const { index } = buildHeaderIndex(headers);
    const m = mapping([
      ['Company', 'lead.name'],
      ['Missing', 'contact.email'],
    ]);
    const r = mapRecord(['Acme'], index, m, ctx);
    expect(r.errors).toEqual([]);
    expect(r.contact.email).toBeNull();
  });
});
