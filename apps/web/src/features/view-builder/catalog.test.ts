import { describe, expect, test } from 'vitest';
import type { DslCustomFieldDef } from '@switchboard/shared';
import { astToDsl, parse } from '@switchboard/shared';
import {
  buildFieldOptions,
  comparatorLabel,
  comparatorsFor,
  leadCustomFields,
  membershipAllowed,
  type BuilderCmp,
} from './catalog.ts';
import { defaultMembershipValue, defaultScalar, withComparator } from './leafOps.ts';
import type { LeafExpr } from './model.ts';

const CATALOG: DslCustomFieldDef[] = [
  { key: 'notes', entity: 'lead', type: 'text', options: null },
  { key: 'employees', entity: 'lead', type: 'number', options: null },
  { key: 'renewal_date', entity: 'lead', type: 'date', options: null },
  { key: 'segment', entity: 'lead', type: 'select', options: ['SMB', 'Enterprise'] },
  { key: 'champion', entity: 'lead', type: 'user', options: null },
  // must be filtered out (non-lead entity):
  { key: 'persona', entity: 'contact', type: 'select', options: ['A'] },
];
const opts = { fieldCatalog: CATALOG };
const options = buildFieldOptions(CATALOG, { statuses: ['Won', 'Lost'] });

function leafFor(cmp: BuilderCmp, opt: (typeof options)[number]): LeafExpr {
  if (cmp === 'is_set' || cmp === 'is_not_set') {
    return { kind: 'presence', field: opt.ref, op: cmp };
  }
  if (cmp === 'in') {
    return { kind: 'membership', field: opt.ref, values: [defaultMembershipValue(opt.type)] };
  }
  return { kind: 'field', field: opt.ref, cmp, value: defaultScalar(opt.type) };
}

describe('catalog ⇄ parser: every offered comparator/value is parser-valid', () => {
  for (const opt of options) {
    for (const cmp of comparatorsFor(opt.type)) {
      test(`${opt.value} (${opt.type}) ${cmp}`, () => {
        const leaf = leafFor(cmp, opt);
        const dsl = astToDsl(leaf);
        // The exact construct the builder would emit must parse back identically.
        expect(parse(dsl, opts)).toEqual(leaf);
      });
    }
  }
});

describe('catalog ⇄ parser: withComparator output is parser-valid', () => {
  for (const opt of options) {
    for (const cmp of comparatorsFor(opt.type)) {
      test(`withComparator ${opt.value} → ${cmp}`, () => {
        const seed: LeafExpr = {
          kind: 'field',
          field: opt.ref,
          cmp: '=',
          value: defaultScalar(opt.type),
        };
        const leaf = withComparator(opt, cmp, seed);
        expect(parse(astToDsl(leaf), opts)).toEqual(leaf);
      });
    }
  }
});

describe('field options', () => {
  test('includes builtins and only lead-entity custom fields', () => {
    const values = options.map((o) => o.value);
    expect(values).toContain('name');
    expect(values).toContain('opportunity.value');
    expect(values).toContain('custom.notes');
    expect(values).toContain('custom.segment');
    // contact-entity custom field is filtered out
    expect(values).not.toContain('custom.persona');
  });

  test('leadCustomFields drops non-lead entities', () => {
    expect(leadCustomFields(CATALOG).map((d) => d.key)).toEqual([
      'notes',
      'employees',
      'renewal_date',
      'segment',
      'champion',
    ]);
  });

  test('status builtin carries the supplied label options', () => {
    const status = options.find((o) => o.value === 'status');
    expect(status?.options).toEqual(['Won', 'Lost']);
  });

  test('custom select carries its option set', () => {
    const segment = options.find((o) => o.value === 'custom.segment');
    expect(segment?.options).toEqual(['SMB', 'Enterprise']);
  });
});

describe('comparator sets', () => {
  test('text offers equality/text ops + membership + presence, not ordering', () => {
    const cmps = comparatorsFor('text');
    expect(cmps).toContain('contains');
    expect(cmps).toContain('starts_with');
    expect(cmps).toContain('in');
    expect(cmps).toContain('is_set');
    expect(cmps).not.toContain('<');
  });

  test('number/date offer ordering, not text ops', () => {
    for (const type of ['number', 'date'] as const) {
      const cmps = comparatorsFor(type);
      expect(cmps).toContain('<=');
      expect(cmps).not.toContain('contains');
    }
    // dates are not membership-eligible; numbers are
    expect(comparatorsFor('date')).not.toContain('in');
    expect(comparatorsFor('number')).toContain('in');
  });

  test('bool offers only equality + presence, never membership', () => {
    const cmps = comparatorsFor('bool');
    expect(cmps).toEqual(['=', '!=', 'is_set', 'is_not_set']);
    expect(membershipAllowed('bool')).toBe(false);
  });

  test('date comparator labels read as before/after', () => {
    expect(comparatorLabel('<', 'date')).toBe('is before');
    expect(comparatorLabel('>', 'date')).toBe('is after');
    expect(comparatorLabel('<', 'number')).toBe('is less than');
  });
});
