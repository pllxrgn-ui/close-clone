/*
 * Pure transitions for a single predicate row. Given the current leaf and a UI
 * change (pick a different field, comparator, activity, …), produce the next
 * type-valid {@link LeafExpr}. Values are preserved across changes when the new
 * shape can still hold them, and replaced with a sensible default otherwise.
 *
 * Keeping this logic pure (no React) means the round-trip + catalog suites can
 * assert every leaf these functions emit survives the parser.
 */
import type {
  ActivityTypeDsl,
  FieldType,
  MembershipValue,
  RelativeUnit,
  ScalarValue,
} from '@switchboard/shared';
import {
  cmpAllowed,
  membershipAllowed,
  scalarKindFor,
  type BuilderCmp,
  type FieldOption,
} from './catalog.ts';
import type { LeafExpr } from './model.ts';

/** Sentinel attribute-select values for the non-field predicate kinds. */
export const ATTR_ACTIVITY = '__activity__';
export const ATTR_TEXT = '__text__';

const VALUE_CMP_ORDER = ['=', '!=', '<', '<=', '>', '>=', 'contains', 'starts_with'] as const;

// ── Defaults ──────────────────────────────────────────────────────────────────

export function defaultScalar(type: FieldType): ScalarValue {
  switch (type) {
    case 'text':
    case 'select':
    case 'user':
      return { kind: 'string', value: '' };
    case 'number':
      return { kind: 'number', value: 0 };
    case 'bool':
      return { kind: 'bool', value: true };
    case 'date':
      // A named relative default reads well ("… is before today") and avoids a
      // clock-dependent literal.
      return { kind: 'reldate', rel: { form: 'named', name: 'today' } };
  }
}

export function defaultMembershipValue(type: FieldType): MembershipValue {
  switch (type) {
    case 'user':
      return { kind: 'me' };
    case 'number':
      return { kind: 'number', value: 0 };
    default:
      return { kind: 'string', value: '' };
  }
}

export function defaultActivity(): LeafExpr {
  return { kind: 'activity', op: 'has', activity: 'call' };
}

export function defaultText(): LeafExpr {
  return { kind: 'text', query: '' };
}

/** First value comparator legal for a field type (the row's default). */
export function defaultValueCmp(type: FieldType): BuilderCmp {
  const first = VALUE_CMP_ORDER.find((c) => cmpAllowed(type, c));
  return first ?? '=';
}

// ── Introspection of the current leaf → UI selection ──────────────────────────

export function attributeOf(expr: LeafExpr): string {
  if (expr.kind === 'activity') return ATTR_ACTIVITY;
  if (expr.kind === 'text') return ATTR_TEXT;
  return expr.field.kind === 'builtin' ? expr.field.name : `custom.${expr.field.key}`;
}

export function comparatorOf(expr: LeafExpr): BuilderCmp | null {
  switch (expr.kind) {
    case 'field':
      return expr.cmp;
    case 'presence':
      return expr.op;
    case 'membership':
      return 'in';
    default:
      return null;
  }
}

// ── Validity helpers ──────────────────────────────────────────────────────────

export function comparatorValidFor(type: FieldType, cmp: BuilderCmp): boolean {
  if (cmp === 'is_set' || cmp === 'is_not_set') return true;
  if (cmp === 'in') return membershipAllowed(type);
  return cmpAllowed(type, cmp);
}

function scalarMatchesType(value: ScalarValue, type: FieldType): boolean {
  const kind = scalarKindFor(type);
  if (kind === 'date') return value.kind === 'date' || value.kind === 'reldate';
  return value.kind === kind;
}

function memberMatchesType(value: MembershipValue, type: FieldType): boolean {
  switch (type) {
    case 'user':
      return value.kind === 'string' || value.kind === 'me';
    case 'number':
      return value.kind === 'number';
    default:
      return value.kind === 'string';
  }
}

// ── Transitions ───────────────────────────────────────────────────────────────

/** Build a leaf for `field` with comparator `cmp`, reusing `prev`'s value/values
 *  when the new shape can still hold them. */
export function withComparator(field: FieldOption, cmp: BuilderCmp, prev: LeafExpr): LeafExpr {
  if (cmp === 'is_set' || cmp === 'is_not_set') {
    return { kind: 'presence', field: field.ref, op: cmp };
  }
  if (cmp === 'in') {
    const kept =
      prev.kind === 'membership' && prev.values.every((v) => memberMatchesType(v, field.type))
        ? prev.values
        : [defaultMembershipValue(field.type)];
    return { kind: 'membership', field: field.ref, values: kept };
  }
  const value =
    prev.kind === 'field' && scalarMatchesType(prev.value, field.type)
      ? prev.value
      : defaultScalar(field.type);
  return { kind: 'field', field: field.ref, cmp, value };
}

/** Build a leaf when the attribute-select changes to `field`, keeping the
 *  comparator if still legal for the new type. */
export function fieldLeaf(field: FieldOption, prev?: LeafExpr): LeafExpr {
  const prevCmp = prev ? comparatorOf(prev) : null;
  const cmp = prevCmp && comparatorValidFor(field.type, prevCmp) ? prevCmp : defaultValueCmp(field.type);
  const fallback: LeafExpr = {
    kind: 'field',
    field: field.ref,
    cmp: '=',
    value: defaultScalar(field.type),
  };
  return withComparator(field, cmp, prev ?? fallback);
}

/** Build a leaf when the attribute-select changes to a non-field kind. */
export function attributeLeaf(attribute: string, field: FieldOption | undefined, prev: LeafExpr): LeafExpr {
  if (attribute === ATTR_ACTIVITY) {
    return prev.kind === 'activity' ? prev : defaultActivity();
  }
  if (attribute === ATTR_TEXT) {
    return prev.kind === 'text' ? prev : defaultText();
  }
  if (field) return fieldLeaf(field, prev);
  return prev;
}

// ── Activity sub-transitions ──────────────────────────────────────────────────

type ActivityLeaf = Extract<LeafExpr, { kind: 'activity' }>;

export function setActivityType(leaf: ActivityLeaf, activity: ActivityTypeDsl): ActivityLeaf {
  const base: ActivityLeaf = { kind: 'activity', op: leaf.op, activity };
  if (leaf.within) base.within = leaf.within;
  // A sequence name is only meaningful for in_sequence; carry/seed it there.
  if (activity === 'in_sequence') base.sequenceName = leaf.sequenceName ?? '';
  return base;
}

export function setActivityWithin(
  leaf: ActivityLeaf,
  within: { n: number; unit: RelativeUnit } | null,
): ActivityLeaf {
  const next: ActivityLeaf = { kind: 'activity', op: leaf.op, activity: leaf.activity };
  if (leaf.sequenceName !== undefined) next.sequenceName = leaf.sequenceName;
  if (within) next.within = within;
  return next;
}
