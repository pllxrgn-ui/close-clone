import { describe, expect, test } from 'vitest';
import type { FieldType } from '@switchboard/shared';
import type { FieldOption } from './catalog.ts';
import {
  ATTR_ACTIVITY,
  ATTR_TEXT,
  attributeLeaf,
  attributeOf,
  comparatorOf,
  defaultValueCmp,
  fieldLeaf,
  setActivityType,
  setActivityWithin,
  withComparator,
} from './leafOps.ts';
import type { LeafExpr } from './model.ts';

function opt(value: string, type: FieldType, options?: string[]): FieldOption {
  const ref =
    value.startsWith('custom.') || !isBuiltin(value)
      ? ({ kind: 'custom', key: value.replace('custom.', ''), type } as const)
      : ({ kind: 'builtin', name: value } as const);
  return { value, ref, type, label: value, ...(options ? { options } : {}), group: 'Lead' };
}
function isBuiltin(value: string): boolean {
  return ['name', 'status', 'owner', 'created', 'dnc'].includes(value);
}

const nameField = opt('name', 'text');
const employeesField = opt('custom.employees', 'number');
const createdField = opt('created', 'date');
const ownerField = opt('owner', 'user');

describe('attributeOf / comparatorOf', () => {
  test('maps each leaf kind to its attribute + comparator', () => {
    expect(
      attributeOf({
        kind: 'field',
        field: nameField.ref,
        cmp: '=',
        value: { kind: 'string', value: 'x' },
      }),
    ).toBe('name');
    expect(attributeOf({ kind: 'activity', op: 'has', activity: 'call' })).toBe(ATTR_ACTIVITY);
    expect(attributeOf({ kind: 'text', query: 'q' })).toBe(ATTR_TEXT);
    expect(comparatorOf({ kind: 'presence', field: nameField.ref, op: 'is_set' })).toBe('is_set');
    expect(
      comparatorOf({
        kind: 'membership',
        field: nameField.ref,
        values: [{ kind: 'string', value: 'a' }],
      }),
    ).toBe('in');
    expect(comparatorOf({ kind: 'activity', op: 'has', activity: 'call' })).toBeNull();
  });
});

describe('withComparator preserves values where the shape allows', () => {
  const base: LeafExpr = {
    kind: 'field',
    field: nameField.ref,
    cmp: '=',
    value: { kind: 'string', value: 'Acme' },
  };

  test('value cmp → value cmp keeps the scalar value', () => {
    const next = withComparator(nameField, 'contains', base);
    expect(next).toEqual({
      kind: 'field',
      field: nameField.ref,
      cmp: 'contains',
      value: { kind: 'string', value: 'Acme' },
    });
  });

  test('→ presence drops the value', () => {
    expect(withComparator(nameField, 'is_set', base)).toEqual({
      kind: 'presence',
      field: nameField.ref,
      op: 'is_set',
    });
  });

  test('→ membership seeds a single default value (min-1 invariant)', () => {
    const next = withComparator(nameField, 'in', base);
    expect(next).toEqual({
      kind: 'membership',
      field: nameField.ref,
      values: [{ kind: 'string', value: '' }],
    });
  });

  test('membership → membership keeps values when type-compatible', () => {
    const m: LeafExpr = {
      kind: 'membership',
      field: nameField.ref,
      values: [
        { kind: 'string', value: 'a' },
        { kind: 'string', value: 'b' },
      ],
    };
    expect(withComparator(nameField, 'in', m)).toEqual(m);
  });
});

describe('fieldLeaf across field changes', () => {
  test('keeps a comparator legal for the new type, defaults the value', () => {
    const prev: LeafExpr = {
      kind: 'field',
      field: nameField.ref,
      cmp: '=',
      value: { kind: 'string', value: 'x' },
    };
    const next = fieldLeaf(employeesField, prev);
    // '=' is legal for number → kept; string value is not → default number 0
    expect(next).toEqual({
      kind: 'field',
      field: employeesField.ref,
      cmp: '=',
      value: { kind: 'number', value: 0 },
    });
  });

  test('drops a comparator illegal for the new type', () => {
    const prev: LeafExpr = {
      kind: 'field',
      field: nameField.ref,
      cmp: 'contains',
      value: { kind: 'string', value: 'x' },
    };
    const next = fieldLeaf(employeesField, prev);
    // 'contains' is illegal for number → default value cmp '='
    expect(next.kind).toBe('field');
    if (next.kind !== 'field') throw new Error('expected field');
    expect(next.cmp).toBe('=');
  });

  test('date field defaults to a named relative value', () => {
    const next = fieldLeaf(createdField);
    expect(next).toEqual({
      kind: 'field',
      field: createdField.ref,
      cmp: '=',
      value: { kind: 'reldate', rel: { form: 'named', name: 'today' } },
    });
  });

  test('membership survives a field swap between two membership-eligible types', () => {
    const prev: LeafExpr = {
      kind: 'membership',
      field: nameField.ref,
      values: [{ kind: 'string', value: 'a' }],
    };
    // name(text) → owner(user): user accepts string members, so values are kept
    const next = fieldLeaf(ownerField, prev);
    expect(next).toEqual({
      kind: 'membership',
      field: ownerField.ref,
      values: [{ kind: 'string', value: 'a' }],
    });
  });
});

describe('attributeLeaf', () => {
  const prev: LeafExpr = {
    kind: 'field',
    field: nameField.ref,
    cmp: '=',
    value: { kind: 'string', value: 'x' },
  };
  test('switches to a fresh activity/text predicate', () => {
    expect(attributeLeaf(ATTR_ACTIVITY, undefined, prev)).toEqual({
      kind: 'activity',
      op: 'has',
      activity: 'call',
    });
    expect(attributeLeaf(ATTR_TEXT, undefined, prev)).toEqual({ kind: 'text', query: '' });
  });
  test('keeps an existing activity leaf when re-selecting Activity', () => {
    const act: LeafExpr = { kind: 'activity', op: 'no', activity: 'email' };
    expect(attributeLeaf(ATTR_ACTIVITY, undefined, act)).toBe(act);
  });
});

describe('activity sub-transitions', () => {
  test('switching to in_sequence seeds an empty name and keeps within', () => {
    const leaf = {
      kind: 'activity',
      op: 'has',
      activity: 'call',
      within: { n: 7, unit: 'd' },
    } as const;
    const next = setActivityType(leaf, 'in_sequence');
    expect(next).toEqual({
      kind: 'activity',
      op: 'has',
      activity: 'in_sequence',
      within: { n: 7, unit: 'd' },
      sequenceName: '',
    });
  });

  test('switching away from in_sequence drops the name', () => {
    const leaf = {
      kind: 'activity',
      op: 'has',
      activity: 'in_sequence',
      sequenceName: 'Onboarding',
    } as const;
    expect(setActivityType(leaf, 'call')).toEqual({
      kind: 'activity',
      op: 'has',
      activity: 'call',
    });
  });

  test('setActivityWithin toggles the window', () => {
    const leaf = { kind: 'activity', op: 'has', activity: 'call' } as const;
    expect(setActivityWithin(leaf, { n: 30, unit: 'd' })).toEqual({
      kind: 'activity',
      op: 'has',
      activity: 'call',
      within: { n: 30, unit: 'd' },
    });
    const withWin = {
      kind: 'activity',
      op: 'has',
      activity: 'call',
      within: { n: 30, unit: 'd' },
    } as const;
    expect(setActivityWithin(withWin, null)).toEqual({
      kind: 'activity',
      op: 'has',
      activity: 'call',
    });
  });
});

describe('defaultValueCmp', () => {
  test('picks a legal first comparator per type', () => {
    expect(defaultValueCmp('text')).toBe('=');
    expect(defaultValueCmp('number')).toBe('=');
    expect(defaultValueCmp('date')).toBe('=');
    expect(defaultValueCmp('bool')).toBe('=');
  });
});
