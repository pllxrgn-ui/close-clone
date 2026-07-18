import { describe, expect, test } from 'vitest';
import {
  formatTarget,
  mappingReadiness,
  parseTarget,
  targetLabel,
  validateTargets,
} from './mapping.ts';

describe('parseTarget', () => {
  test('recognizes ignore, lead, contact, and custom targets', () => {
    expect(parseTarget('ignore')).toEqual({ kind: 'ignore' });
    expect(parseTarget('lead.name')).toEqual({ kind: 'lead', field: 'name' });
    expect(parseTarget('contact.email')).toEqual({ kind: 'contact', field: 'email' });
    expect(parseTarget('custom.segment')).toEqual({ kind: 'custom', key: 'segment' });
  });
  test('rejects unknown builtin fields and bad syntax', () => {
    expect(parseTarget('lead.bogus')).toBeNull();
    expect(parseTarget('contact.company')).toBeNull();
    expect(parseTarget('nonsense')).toBeNull();
    expect(parseTarget('lead.')).toBeNull();
  });
});

describe('formatTarget', () => {
  test('round-trips every kind', () => {
    for (const s of ['ignore', 'lead.name', 'contact.phone', 'custom.region']) {
      const parsed = parseTarget(s);
      expect(parsed).not.toBeNull();
      if (parsed) expect(formatTarget(parsed)).toBe(s);
    }
  });
});

describe('targetLabel', () => {
  const custom = new Map([['segment', { label: 'Segment' }]]);
  test('renders a readable two-part label', () => {
    expect(targetLabel('ignore', custom)).toBe('Ignore');
    expect(targetLabel('lead.name', custom)).toBe('Lead → Name');
    expect(targetLabel('contact.email', custom)).toBe('Contact → Email');
    expect(targetLabel('custom.segment', custom)).toBe('Custom → Segment');
  });
  test('falls back to the raw key for an unknown custom field', () => {
    expect(targetLabel('custom.mystery', custom)).toBe('Custom → mystery');
  });
});

describe('validateTargets', () => {
  const keys = new Set(['segment', 'region']);
  test('passes a clean mapping', () => {
    expect(
      validateTargets(
        [
          { source: 'Company', target: 'lead.name' },
          { source: 'Segment', target: 'custom.segment' },
        ],
        keys,
      ),
    ).toEqual([]);
  });
  test('flags an unknown custom field', () => {
    const errs = validateTargets([{ source: 'X', target: 'custom.unknown' }], keys);
    expect(errs.some((e) => e.includes('custom.unknown'))).toBe(true);
  });
  test('flags a syntactically invalid target', () => {
    const errs = validateTargets([{ source: 'X', target: 'lead.bogus' }], keys);
    expect(errs.some((e) => e.includes('lead.bogus'))).toBe(true);
  });
});

describe('mappingReadiness', () => {
  const keys = new Set(['segment']);
  test('is not ready when every column is ignored', () => {
    const r = mappingReadiness([{ source: 'A', target: 'ignore' }], keys);
    expect(r.ready).toBe(false);
    expect(r.issues.join(' ')).toMatch(/at least one column/i);
  });
  test('is not ready without a lead-name mapping', () => {
    const r = mappingReadiness([{ source: 'Email', target: 'contact.email' }], keys);
    expect(r.ready).toBe(false);
    expect(r.issues.join(' ')).toMatch(/Lead → Name/);
  });
  test('is ready once a company name is mapped', () => {
    const r = mappingReadiness(
      [
        { source: 'Company', target: 'lead.name' },
        { source: 'Email', target: 'contact.email' },
      ],
      keys,
    );
    expect(r.ready).toBe(true);
    expect(r.issues).toEqual([]);
  });
  test('surfaces target validation errors as readiness issues', () => {
    const r = mappingReadiness(
      [
        { source: 'Company', target: 'lead.name' },
        { source: 'X', target: 'custom.nope' },
      ],
      keys,
    );
    expect(r.ready).toBe(false);
    expect(r.issues.some((i) => i.includes('custom.nope'))).toBe(true);
  });
});
