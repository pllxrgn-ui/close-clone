/*
 * Field catalog + type rules for the visual builder.
 *
 * CONTRACT FRICTION (reported upward): the parser's type-check helpers
 * (`cmpAllowed`, `membershipAllowed`, `allowedValueKinds`, `isBuiltinField`) are
 * NOT re-exported from `@switchboard/shared` — only `BUILTIN_FIELDS`,
 * `VALUE_CMPS`, `PRESENCE_CMPS` and the types are. To keep the builder from
 * emitting predicates the parser would reject, the same rules are mirrored here
 * as an adapter-stub. The mirror is not trusted on faith: catalog.test.ts and
 * the round-trip property suite assert that every comparator/value the catalog
 * offers survives `parse(astToDsl(leaf))` unchanged, so any drift from the real
 * parser fails the build.
 */
import {
  ACTIVITY_TYPES_DSL,
  BUILTIN_FIELDS,
  NAMED_RELDATES,
  PRESENCE_CMPS,
  RELATIVE_UNITS,
  VALUE_CMPS,
  type ActivityTypeDsl,
  type BuiltinFieldName,
  type DslCustomFieldDef,
  type FieldRef,
  type FieldType,
  type PresenceCmp,
  type RelativeUnit,
  type ValueCmp,
} from '@switchboard/shared';

// ── Type rules (mirror of packages/shared/src/dsl/fields.ts) ──────────────────

const ORDER_CMPS: readonly ValueCmp[] = ['=', '!=', '<', '<=', '>', '>='];
const TEXT_CMPS: readonly ValueCmp[] = ['=', '!=', 'contains', 'starts_with'];
const EQ_CMPS: readonly ValueCmp[] = ['=', '!='];

/** Value comparators legal for a field of `type` (mirrors `cmpAllowed`). */
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

/** Whether `field in (...)` is legal for `type` (mirrors `membershipAllowed`). */
export function membershipAllowed(type: FieldType): boolean {
  return type === 'text' || type === 'number' || type === 'user' || type === 'select';
}

/** The value editor kind for a scalar comparison on `type`. `date` fields carry
 *  two kinds (exact date OR relative), handled by the value editor's mode. */
export type ScalarValueKind = 'string' | 'number' | 'bool' | 'date';

export function scalarKindFor(type: FieldType): ScalarValueKind {
  switch (type) {
    case 'text':
    case 'select':
    case 'user':
      return 'string';
    case 'number':
      return 'number';
    case 'bool':
      return 'bool';
    case 'date':
      return 'date';
  }
}

// ── Field options (builtins + lead-entity custom fields) ──────────────────────

export interface FieldOption {
  /** Stable option value used in the <select> (unique across builtins/custom). */
  readonly value: string;
  readonly ref: FieldRef;
  readonly type: FieldType;
  readonly label: string;
  /** For `select`/`user` fields with a known option set, the choices to offer. */
  readonly options?: readonly string[];
  readonly group: 'Lead' | 'Opportunity' | 'Contact' | 'Custom';
}

const BUILTIN_LABELS: Record<BuiltinFieldName, string> = {
  name: 'Name',
  status: 'Status',
  owner: 'Owner',
  created: 'Created',
  updated: 'Updated',
  last_contacted: 'Last contacted',
  last_inbound: 'Last inbound',
  next_task_due: 'Next task due',
  dnc: 'Do not contact',
  'opportunity.value': 'Opportunity value',
  'opportunity.stage': 'Opportunity stage',
  'opportunity.close_date': 'Opportunity close date',
  'contact.email': 'Contact email',
  'contact.phone': 'Contact phone',
  'contact.title': 'Contact title',
};

function builtinGroup(name: BuiltinFieldName): FieldOption['group'] {
  if (name.startsWith('opportunity.')) return 'Opportunity';
  if (name.startsWith('contact.')) return 'Contact';
  return 'Lead';
}

/** Options that drive a builtin select/user field, when the caller supplies a
 *  reference set (statuses, opportunity stages, users). */
export interface CatalogRefs {
  readonly statuses?: readonly string[];
  readonly opportunityStages?: readonly string[];
  readonly users?: readonly string[];
}

function builtinFieldOptions(refs: CatalogRefs): FieldOption[] {
  return (Object.keys(BUILTIN_FIELDS) as BuiltinFieldName[]).map((name) => {
    const type = BUILTIN_FIELDS[name];
    let options: readonly string[] | undefined;
    if (name === 'status') options = refs.statuses;
    else if (name === 'opportunity.stage') options = refs.opportunityStages;
    else if (name === 'owner') options = refs.users;
    return {
      value: name,
      ref: { kind: 'builtin', name },
      type,
      label: BUILTIN_LABELS[name],
      ...(options ? { options } : {}),
      group: builtinGroup(name),
    };
  });
}

/** The parser only resolves `custom.<key>` for `entity === 'lead'` fields, so
 *  the builder must offer exactly those (contact/opportunity custom fields are
 *  filtered out — surfacing them would produce un-parseable DSL). */
export function leadCustomFields(defs: readonly DslCustomFieldDef[]): DslCustomFieldDef[] {
  return defs.filter((d) => d.entity === 'lead');
}

function customFieldOptions(defs: readonly DslCustomFieldDef[]): FieldOption[] {
  return leadCustomFields(defs).map((d) => {
    const opts = Array.isArray(d.options)
      ? d.options.filter((o): o is string => typeof o === 'string')
      : undefined;
    return {
      value: `custom.${d.key}`,
      ref: { kind: 'custom', key: d.key, type: d.type },
      type: d.type,
      label: humanizeKey(d.key),
      ...(opts && opts.length > 0 ? { options: opts } : {}),
      group: 'Custom',
    };
  });
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/[_.]/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Build the full field-picker option list. Custom fields (lead entity only)
 *  follow the builtins; labels are used for display, `value` for identity. */
export function buildFieldOptions(
  customFields: readonly DslCustomFieldDef[],
  refs: CatalogRefs = {},
): FieldOption[] {
  return [...builtinFieldOptions(refs), ...customFieldOptions(customFields)];
}

export function findFieldOption(
  options: readonly FieldOption[],
  ref: FieldRef,
): FieldOption | undefined {
  const value = ref.kind === 'builtin' ? ref.name : `custom.${ref.key}`;
  return options.find((o) => o.value === value);
}

// ── Comparators ───────────────────────────────────────────────────────────────

/**
 * Comparator options offered for a field of `type`, in a stable display order:
 * value comparators (constrained by type), then membership (`in`) where legal,
 * then presence (`is_set`/`is_not_set`, valid on every field). `in` is a
 * pseudo-comparator that selects a membership predicate.
 */
export type BuilderCmp = ValueCmp | PresenceCmp | 'in';

export function comparatorsFor(type: FieldType): BuilderCmp[] {
  const cmps: BuilderCmp[] = VALUE_CMPS.filter((c) => cmpAllowed(type, c));
  if (membershipAllowed(type)) cmps.push('in');
  cmps.push(...PRESENCE_CMPS);
  return cmps;
}

const CMP_LABELS: Record<BuilderCmp, string> = {
  '=': 'is',
  '!=': 'is not',
  '<': 'is less than',
  '<=': 'is at most',
  '>': 'is greater than',
  '>=': 'is at least',
  contains: 'contains',
  starts_with: 'starts with',
  in: 'is any of',
  is_set: 'is set',
  is_not_set: 'is not set',
};

const DATE_CMP_LABELS: Partial<Record<BuilderCmp, string>> = {
  '<': 'is before',
  '<=': 'is on or before',
  '>': 'is after',
  '>=': 'is on or after',
};

export function comparatorLabel(cmp: BuilderCmp, type: FieldType): string {
  if (type === 'date' && DATE_CMP_LABELS[cmp]) return DATE_CMP_LABELS[cmp];
  return CMP_LABELS[cmp];
}

// ── Activity + unit + named-reldate metadata ──────────────────────────────────

export const ACTIVITY_OPTIONS: readonly ActivityTypeDsl[] = ACTIVITY_TYPES_DSL;

const ACTIVITY_LABELS: Record<ActivityTypeDsl, string> = {
  call: 'a call',
  email: 'an email (any)',
  inbound_email: 'an inbound email',
  sms: 'an SMS',
  note: 'a note',
  task_completed: 'a completed task',
  sequence: 'any sequence',
  in_sequence: 'a named sequence',
};

export function activityLabel(activity: ActivityTypeDsl): string {
  return ACTIVITY_LABELS[activity];
}

export const UNIT_OPTIONS: readonly RelativeUnit[] = RELATIVE_UNITS;

const UNIT_LABELS: Record<RelativeUnit, string> = {
  h: 'hours',
  d: 'days',
  w: 'weeks',
  mo: 'months',
};

export function unitLabel(unit: RelativeUnit): string {
  return UNIT_LABELS[unit];
}

export const NAMED_RELDATE_OPTIONS = NAMED_RELDATES;

const NAMED_RELDATE_LABELS: Record<(typeof NAMED_RELDATES)[number], string> = {
  today: 'today',
  this_week: 'this week',
  this_month: 'this month',
};

export function namedReldateLabel(name: (typeof NAMED_RELDATES)[number]): string {
  return NAMED_RELDATE_LABELS[name];
}
