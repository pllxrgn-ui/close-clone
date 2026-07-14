/**
 * fast-check arbitraries for the Smart View AST (test infrastructure).
 *
 * Generates only *type-valid* ASTs in the exact normal form the parser
 * produces, so `parse(astToDsl(a)) ≡ a` holds. Not part of the public API and
 * not exported through the package barrel.
 */
import fc from 'fast-check';

import type { Ast, FieldRef, MembershipValue, ScalarValue } from './ast.ts';
import { ACTIVITY_TYPES_DSL } from './ast.ts';
import type { DslCustomFieldDef } from './index.ts';
import {
  BUILTIN_FIELDS,
  BUILTIN_FIELD_NAMES,
  membershipAllowed,
  type FieldType,
  type ValueCmp,
} from './fields.ts';

const UNIT_ARB = fc.constantFrom('h' as const, 'd' as const, 'w' as const, 'mo' as const);

/** Fixed lead-entity custom field catalog used by the property tests. */
export const TEST_CATALOG: DslCustomFieldDef[] = [
  { key: 'industry', entity: 'lead', type: 'text', options: null },
  { key: 'employees', entity: 'lead', type: 'number', options: null },
  { key: 'renewal_date', entity: 'lead', type: 'date', options: null },
  { key: 'tier', entity: 'lead', type: 'select', options: ['gold', 'silver'] },
  { key: 'csm', entity: 'lead', type: 'user', options: null },
];

interface FieldDesc {
  ref: FieldRef;
  type: FieldType;
}

const BUILTIN_DESCS: FieldDesc[] = BUILTIN_FIELD_NAMES.map((name) => ({
  ref: { kind: 'builtin', name },
  type: BUILTIN_FIELDS[name],
}));

const CUSTOM_DESCS: FieldDesc[] = TEST_CATALOG.map((d) => ({
  ref: { kind: 'custom', key: d.key, type: d.type },
  type: d.type,
}));

const ALL_DESCS: FieldDesc[] = [...BUILTIN_DESCS, ...CUSTOM_DESCS];
const MEMBER_DESCS: FieldDesc[] = ALL_DESCS.filter((d) => membershipAllowed(d.type));

const pad = (n: number): string => String(n).padStart(2, '0');

const dateOnlyArb = fc
  .tuple(
    fc.integer({ min: 2000, max: 2035 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => `${y}-${pad(m)}-${pad(d)}`);

const dateTimeArb = fc
  .tuple(dateOnlyArb, fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([d, h, mi]) => `${d}T${pad(h)}:${pad(mi)}:00`);

const dateStrArb = fc.oneof(dateOnlyArb, dateTimeArb);

const reldateArb: fc.Arbitrary<ScalarValue> = fc.oneof(
  fc
    .record({ n: fc.integer({ min: 0, max: 999 }), unit: UNIT_ARB })
    .map(({ n, unit }) => ({ kind: 'reldate', rel: { form: 'relative', n, unit } }) as ScalarValue),
  fc
    .constantFrom('today' as const, 'this_week' as const, 'this_month' as const)
    .map((name) => ({ kind: 'reldate', rel: { form: 'named', name } }) as ScalarValue),
);

const stringArb = fc.string();
const numberArb = fc.integer({ min: -1_000_000, max: 1_000_000 });

function scalarForType(type: FieldType): fc.Arbitrary<ScalarValue> {
  switch (type) {
    case 'text':
    case 'select':
    case 'user':
      return stringArb.map((value) => ({ kind: 'string', value }));
    case 'number':
      return numberArb.map((value) => ({ kind: 'number', value }));
    case 'bool':
      return fc.boolean().map((value) => ({ kind: 'bool', value }));
    case 'date':
      return fc.oneof(
        dateStrArb.map((value) => ({ kind: 'date', value }) as ScalarValue),
        reldateArb,
      );
  }
}

function cmpForType(type: FieldType): fc.Arbitrary<ValueCmp> {
  switch (type) {
    case 'text':
      return fc.constantFrom<ValueCmp[]>('=', '!=', 'contains', 'starts_with');
    case 'number':
    case 'date':
      return fc.constantFrom<ValueCmp[]>('=', '!=', '<', '<=', '>', '>=');
    case 'bool':
    case 'user':
    case 'select':
      return fc.constantFrom<ValueCmp[]>('=', '!=');
  }
}

const fieldPredArb: fc.Arbitrary<Ast> = fc
  .constantFrom(...ALL_DESCS)
  .chain((desc) =>
    fc
      .tuple(cmpForType(desc.type), scalarForType(desc.type))
      .map(([cmp, value]) => ({ kind: 'field', field: desc.ref, cmp, value }) as Ast),
  );

const presenceArb: fc.Arbitrary<Ast> = fc
  .tuple(fc.constantFrom(...ALL_DESCS), fc.constantFrom('is_set' as const, 'is_not_set' as const))
  .map(([desc, op]) => ({ kind: 'presence', field: desc.ref, op }));

function memberValueForType(type: FieldType): fc.Arbitrary<MembershipValue> {
  switch (type) {
    case 'user':
      return fc.oneof(
        stringArb.map((value) => ({ kind: 'string', value }) as MembershipValue),
        fc.constant({ kind: 'me' } as MembershipValue),
      );
    case 'number':
      return numberArb.map((value) => ({ kind: 'number', value }));
    default:
      return stringArb.map((value) => ({ kind: 'string', value }));
  }
}

const membershipArb: fc.Arbitrary<Ast> = fc
  .constantFrom(...MEMBER_DESCS)
  .chain((desc) =>
    fc
      .array(memberValueForType(desc.type), { minLength: 1, maxLength: 4 })
      .map((values) => ({ kind: 'membership', field: desc.ref, values })),
  );

const activityArb: fc.Arbitrary<Ast> = fc.constantFrom(...ACTIVITY_TYPES_DSL).chain((activity) =>
  fc
    .record({
      op: fc.constantFrom('has' as const, 'no' as const),
      within: fc.option(fc.record({ n: fc.integer({ min: 0, max: 999 }), unit: UNIT_ARB }), {
        nil: undefined,
      }),
      name: activity === 'in_sequence' ? stringArb : fc.constant(undefined),
    })
    .map(({ op, within, name }) => ({
      kind: 'activity',
      op,
      activity,
      ...(name !== undefined ? { sequenceName: name } : {}),
      ...(within !== undefined ? { within } : {}),
    })),
);

const textArb: fc.Arbitrary<Ast> = stringArb.map((query) => ({ kind: 'text', query }));

const leafArb: fc.Arbitrary<Ast> = fc.oneof(
  fieldPredArb,
  presenceArb,
  membershipArb,
  activityArb,
  textArb,
);

function exprOfDepth(depth: number): fc.Arbitrary<Ast> {
  if (depth <= 0) return leafArb;
  const sub = exprOfDepth(depth - 1);
  return fc.oneof(
    { weight: 5, arbitrary: leafArb },
    { weight: 1, arbitrary: sub.map((expr) => ({ kind: 'not', expr }) as Ast) },
    {
      weight: 2,
      arbitrary: fc.tuple(sub, sub).map(([left, right]) => ({ kind: 'and', left, right }) as Ast),
    },
    {
      weight: 2,
      arbitrary: fc.tuple(sub, sub).map(([left, right]) => ({ kind: 'or', left, right }) as Ast),
    },
  );
}

/** Arbitrary yielding type-valid ASTs (bounded depth) for property tests. */
export const astArb: fc.Arbitrary<Ast> = exprOfDepth(4);
