/**
 * Field catalog and type system for the Smart View DSL (CONTRACTS §C3, §C1).
 *
 * The set of builtin fields, their types, and the comparator/value rules used
 * for parse-time type checking live here so the parser, serializer and compiler
 * share a single source of truth.
 */

/** Logical types a field can carry. `select`/`user` are enum-like (label/id). */
export type FieldType = 'text' | 'number' | 'date' | 'bool' | 'user' | 'select';

/** Builtin fields from the C3 grammar, mapped to their logical type. */
export const BUILTIN_FIELDS = {
  name: 'text',
  status: 'select',
  owner: 'user',
  created: 'date',
  updated: 'date',
  last_contacted: 'date',
  last_inbound: 'date',
  next_task_due: 'date',
  dnc: 'bool',
  'opportunity.value': 'number',
  'opportunity.stage': 'select',
  'opportunity.close_date': 'date',
  'contact.email': 'text',
  'contact.phone': 'text',
  'contact.title': 'text',
} as const satisfies Record<string, FieldType>;

export type BuiltinFieldName = keyof typeof BUILTIN_FIELDS;

export const BUILTIN_FIELD_NAMES = Object.keys(BUILTIN_FIELDS) as BuiltinFieldName[];

export function isBuiltinField(name: string): name is BuiltinFieldName {
  return Object.prototype.hasOwnProperty.call(BUILTIN_FIELDS, name);
}

/** Comparators that take a value (i.e. everything except is_set/is_not_set). */
export const VALUE_CMPS = ['=', '!=', '<', '<=', '>', '>=', 'contains', 'starts_with'] as const;
export type ValueCmp = (typeof VALUE_CMPS)[number];

/** Presence comparators (no value operand). */
export const PRESENCE_CMPS = ['is_set', 'is_not_set'] as const;
export type PresenceCmp = (typeof PRESENCE_CMPS)[number];

export function isValueCmp(s: string): s is ValueCmp {
  return (VALUE_CMPS as readonly string[]).includes(s);
}
export function isPresenceCmp(s: string): s is PresenceCmp {
  return (PRESENCE_CMPS as readonly string[]).includes(s);
}

const ORDER_CMPS: readonly ValueCmp[] = ['=', '!=', '<', '<=', '>', '>='];
const TEXT_CMPS: readonly ValueCmp[] = ['=', '!=', 'contains', 'starts_with'];
const EQ_CMPS: readonly ValueCmp[] = ['=', '!='];

/** Whether a value comparator is legal for a field of the given type. */
export function cmpAllowed(type: FieldType, cmp: ValueCmp): boolean {
  switch (type) {
    case 'text':
      return TEXT_CMPS.includes(cmp);
    case 'number':
    case 'date':
      return ORDER_CMPS.includes(cmp);
    case 'bool':
    case 'user':
    case 'select':
      return EQ_CMPS.includes(cmp);
  }
}

/** Whether membership (`field in (...)`) is legal for the given field type. */
export function membershipAllowed(type: FieldType): boolean {
  return type === 'text' || type === 'number' || type === 'user' || type === 'select';
}

/** The literal value-kinds acceptable for a scalar comparison on a field type. */
export function allowedValueKinds(type: FieldType): readonly string[] {
  switch (type) {
    case 'text':
    case 'select':
      return ['string'];
    case 'number':
      return ['number'];
    case 'date':
      return ['date', 'reldate'];
    case 'bool':
      return ['bool'];
    case 'user':
      return ['string'];
  }
}
