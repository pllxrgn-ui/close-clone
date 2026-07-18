/*
 * Column-mapping target catalog + validation for the Map step. `parseTarget` /
 * `validateTargets` mirror the server engine (services/imports/mapping.ts) so a
 * mapping the wizard accepts is one the real dry-run accepts; `mappingReadiness`
 * adds the client-only UX guard (you need a Lead → Name column, else every fresh
 * row would error at plan time).
 */
import {
  CONTACT_TARGET_FIELDS,
  LEAD_TARGET_FIELDS,
  type ContactTargetField,
  type ImportColumn,
  type LeadTargetField,
  type MappingTarget,
} from '../types.ts';

export const IGNORE_TARGET = 'ignore';

export const LEAD_FIELD_LABELS: Record<LeadTargetField, string> = {
  name: 'Name',
  url: 'Website',
  description: 'Description',
  dnc: 'Do not contact',
  status: 'Status',
  owner: 'Owner',
};

export const CONTACT_FIELD_LABELS: Record<ContactTargetField, string> = {
  name: 'Name',
  title: 'Title',
  email: 'Email',
  phone: 'Phone',
};

const LEAD_FIELD_SET = new Set<string>(LEAD_TARGET_FIELDS);
const CONTACT_FIELD_SET = new Set<string>(CONTACT_TARGET_FIELDS);

/** Parse a target string (`ignore` | `lead.x` | `contact.x` | `custom.key`). */
export function parseTarget(target: string): MappingTarget | null {
  if (target === IGNORE_TARGET) return { kind: 'ignore' };
  const dot = target.indexOf('.');
  if (dot <= 0) return null;
  const head = target.slice(0, dot);
  const rest = target.slice(dot + 1);
  if (rest.length === 0) return null;
  if (head === 'lead') {
    return LEAD_FIELD_SET.has(rest) ? { kind: 'lead', field: rest as LeadTargetField } : null;
  }
  if (head === 'contact') {
    return CONTACT_FIELD_SET.has(rest)
      ? { kind: 'contact', field: rest as ContactTargetField }
      : null;
  }
  if (head === 'custom') return { kind: 'custom', key: rest };
  return null;
}

/** Serialize a parsed target back to its wire string. */
export function formatTarget(t: MappingTarget): string {
  switch (t.kind) {
    case 'ignore':
      return IGNORE_TARGET;
    case 'lead':
      return `lead.${t.field}`;
    case 'contact':
      return `contact.${t.field}`;
    case 'custom':
      return `custom.${t.key}`;
  }
}

/** Human "Group → Field" label for a target string (ledger + summaries). */
export function targetLabel(target: string, customByKey: Map<string, { label: string }>): string {
  const t = parseTarget(target);
  if (t === null) return target;
  switch (t.kind) {
    case 'ignore':
      return 'Ignore';
    case 'lead':
      return `Lead → ${LEAD_FIELD_LABELS[t.field]}`;
    case 'contact':
      return `Contact → ${CONTACT_FIELD_LABELS[t.field]}`;
    case 'custom':
      return `Custom → ${customByKey.get(t.key)?.label ?? t.key}`;
  }
}

/**
 * Engine-parity validation: reject bad target syntax and custom keys absent from
 * the lead custom-field defs. Returned as human strings (the shape the real
 * `VALIDATION_FAILED` reply carries in `details`).
 */
export function validateTargets(
  columns: readonly ImportColumn[],
  customKeys: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  for (const col of columns) {
    const t = parseTarget(col.target);
    if (t === null) {
      errors.push(`invalid target "${col.target}" for column "${col.source}"`);
      continue;
    }
    if (t.kind === 'custom' && !customKeys.has(t.key)) {
      errors.push(`unknown custom field "custom.${t.key}" for column "${col.source}"`);
    }
  }
  return errors;
}

export interface MappingReadiness {
  ready: boolean;
  issues: string[];
}

/**
 * Whether this mapping can be dry-run. Beyond target validity it requires a
 * Lead → Name column: without one, every non-duplicate row fails the engine's
 * `missing_lead_name` check, so the wizard blocks with a fixable message instead.
 */
export function mappingReadiness(
  columns: readonly ImportColumn[],
  customKeys: ReadonlySet<string>,
): MappingReadiness {
  const issues = validateTargets(columns, customKeys);
  const active = columns.filter((c) => c.target !== IGNORE_TARGET);
  if (active.length === 0) {
    issues.push('Map at least one column to a field before running a dry run.');
  } else {
    const hasLeadName = columns.some((c) => {
      const t = parseTarget(c.target);
      return t?.kind === 'lead' && t.field === 'name';
    });
    if (!hasLeadName) {
      issues.push('Map a column to Lead → Name so new companies can be created.');
    }
  }
  return { ready: issues.length === 0, issues };
}
