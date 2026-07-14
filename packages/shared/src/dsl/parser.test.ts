import { describe, expect, it } from 'vitest';

import type { CustomFieldDef } from './ast.ts';
import { ParseError } from './errors.ts';
import { parse } from './parser.ts';

const CATALOG: CustomFieldDef[] = [
  { key: 'industry', entity: 'lead', type: 'text', options: null },
  { key: 'employees', entity: 'lead', type: 'number', options: null },
  { key: 'renewal_date', entity: 'lead', type: 'date', options: null },
  { key: 'tier', entity: 'lead', type: 'select', options: ['gold', 'silver'] },
  { key: 'csm', entity: 'lead', type: 'user', options: null },
  { key: 'contact_only', entity: 'contact', type: 'text', options: null },
];
const opts = { fieldCatalog: CATALOG };

describe('parser — field predicates', () => {
  it('parses text comparators', () => {
    expect(parse('name = "Acme"')).toEqual({
      kind: 'field',
      field: { kind: 'builtin', name: 'name' },
      cmp: '=',
      value: { kind: 'string', value: 'Acme' },
    });
    expect(parse('name contains "co"').kind).toBe('field');
    expect(parse('name starts_with "A"').kind).toBe('field');
  });

  it('parses ordered comparators on dates and numbers', () => {
    expect(parse('created >= 2024-01-01')).toMatchObject({
      cmp: '>=',
      value: { kind: 'date', value: '2024-01-01' },
    });
    expect(parse('opportunity.value > 1000')).toMatchObject({
      field: { kind: 'builtin', name: 'opportunity.value' },
      cmp: '>',
      value: { kind: 'number', value: 1000 },
    });
  });

  it('parses relative and named dates', () => {
    expect(parse('created > 30d ago')).toMatchObject({
      value: { kind: 'reldate', rel: { form: 'relative', n: 30, unit: 'd' } },
    });
    expect(parse('last_contacted >= this_week')).toMatchObject({
      value: { kind: 'reldate', rel: { form: 'named', name: 'this_week' } },
    });
  });

  it('parses booleans and presence', () => {
    expect(parse('dnc = true')).toMatchObject({ value: { kind: 'bool', value: true } });
    expect(parse('next_task_due is_set')).toEqual({
      kind: 'presence',
      field: { kind: 'builtin', name: 'next_task_due' },
      op: 'is_set',
    });
  });

  it('is case-insensitive for keywords but preserves string content', () => {
    expect(parse('NAME Contains "MixedCase"')).toMatchObject({
      cmp: 'contains',
      value: { kind: 'string', value: 'MixedCase' },
    });
    expect(parse('DNC = TRUE')).toMatchObject({ value: { kind: 'bool', value: true } });
  });
});

describe('parser — custom fields', () => {
  it('types custom fields from the catalog', () => {
    expect(parse('custom.industry = "saas"', opts)).toMatchObject({
      field: { kind: 'custom', key: 'industry', type: 'text' },
    });
    expect(parse('custom.employees >= 10', opts)).toMatchObject({
      field: { kind: 'custom', key: 'employees', type: 'number' },
    });
  });

  it('rejects unknown custom keys', () => {
    expect(() => parse('custom.nope = "x"', opts)).toThrow(ParseError);
  });

  it('rejects a custom key defined only for a non-lead entity', () => {
    expect(() => parse('custom.contact_only = "x"', opts)).toThrow(/unknown custom field/);
  });

  it('type-checks custom comparator/value', () => {
    expect(() => parse('custom.employees contains "x"', opts)).toThrow(ParseError);
    expect(() => parse('custom.industry > 5', opts)).toThrow(ParseError);
  });
});

describe('parser — membership', () => {
  it('parses membership with me', () => {
    expect(parse('owner in (me)')).toEqual({
      kind: 'membership',
      field: { kind: 'builtin', name: 'owner' },
      values: [{ kind: 'me' }],
    });
  });

  it('parses multi-value membership', () => {
    expect(parse('status in ("Won", "Lost")')).toMatchObject({
      kind: 'membership',
      values: [
        { kind: 'string', value: 'Won' },
        { kind: 'string', value: 'Lost' },
      ],
    });
  });

  it('rejects membership on unsupported field types', () => {
    expect(() => parse('created in (2024-01-01)')).toThrow(/does not support/);
    expect(() => parse('dnc in (true)')).toThrow(/does not support/);
  });

  it('rejects an empty membership list', () => {
    expect(() => parse('owner in ()')).toThrow(ParseError);
  });

  it('type-checks membership values', () => {
    expect(() => parse('custom.employees in ("x")', opts)).toThrow(ParseError);
  });
});

describe('parser — activity predicates', () => {
  it('parses has/no with denormalized activities', () => {
    expect(parse('has call')).toEqual({ kind: 'activity', op: 'has', activity: 'call' });
    expect(parse('no email')).toEqual({ kind: 'activity', op: 'no', activity: 'email' });
  });

  it('parses within clauses', () => {
    expect(parse('has call within 7d')).toEqual({
      kind: 'activity',
      op: 'has',
      activity: 'call',
      within: { n: 7, unit: 'd' },
    });
  });

  it('parses in_sequence with a quoted name', () => {
    expect(parse('has in_sequence("Onboarding")')).toEqual({
      kind: 'activity',
      op: 'has',
      activity: 'in_sequence',
      sequenceName: 'Onboarding',
    });
  });

  it('rejects unknown activity types and bad durations', () => {
    expect(() => parse('has bogus')).toThrow(ParseError);
    expect(() => parse('has call within 7x')).toThrow(ParseError);
    expect(() => parse('has call within 1.5d')).toThrow(/non-negative integer/);
    expect(() => parse('has in_sequence(5)')).toThrow(ParseError);
  });
});

describe('parser — text predicate', () => {
  it('parses matches', () => {
    expect(parse('matches "quarterly review"')).toEqual({
      kind: 'text',
      query: 'quarterly review',
    });
  });

  it('rejects matches without a string', () => {
    expect(() => parse('matches 5')).toThrow(ParseError);
  });
});

describe('parser — boolean structure & precedence', () => {
  it('binds not tighter than and tighter than or', () => {
    const ast = parse('dnc = true and has call or matches "x"');
    expect(ast).toEqual({
      kind: 'or',
      left: {
        kind: 'and',
        left: {
          kind: 'field',
          field: { kind: 'builtin', name: 'dnc' },
          cmp: '=',
          value: { kind: 'bool', value: true },
        },
        right: { kind: 'activity', op: 'has', activity: 'call' },
      },
      right: { kind: 'text', query: 'x' },
    });
  });

  it('parses parenthesized grouping', () => {
    const ast = parse('not (has call or has email)');
    expect(ast).toEqual({
      kind: 'not',
      expr: {
        kind: 'or',
        left: { kind: 'activity', op: 'has', activity: 'call' },
        right: { kind: 'activity', op: 'has', activity: 'email' },
      },
    });
  });

  it('is left-associative for chained and/or', () => {
    const ast = parse('has call and has email and has sms');
    expect(ast).toMatchObject({ kind: 'and', left: { kind: 'and' } });
  });
});

describe('parser — failure paths carry position', () => {
  it('reports unknown fields', () => {
    expect(() => parse('foo = 1')).toThrow(/unknown field/);
  });

  it('reports type errors as parse errors', () => {
    expect(() => parse('name < 5')).toThrow(ParseError);
    expect(() => parse('dnc > 3')).toThrow(ParseError);
    expect(() => parse('opportunity.value contains "x"')).toThrow(ParseError);
  });

  it('reports missing values and trailing input', () => {
    expect(() => parse('name =')).toThrow(ParseError);
    expect(() => parse('has call garbage')).toThrow(/trailing/);
    expect(() => parse('(has call')).toThrow(/expected '\)'/);
  });

  it('reports empty input', () => {
    expect(() => parse('')).toThrow(ParseError);
  });

  it('carries a 1-based position on the error', () => {
    try {
      parse('has call and name < 5');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      const pos = (e as ParseError).position;
      expect(pos.line).toBe(1);
      expect(pos.col).toBeGreaterThan(1);
    }
  });
});
