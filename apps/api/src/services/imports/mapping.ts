import {
  CONTACT_TARGET_FIELDS,
  LEAD_TARGET_FIELDS,
  type ContactTargetField,
  type ImportMapping,
  type LeadTargetField,
  type MappingTarget,
  type RowError,
} from './types.ts';

/**
 * Column → field mapping (Task 4f). Resolves each mapped cell to a typed value —
 * builtins (lead/contact columns) and custom fields typed per
 * `custom_field_defs` (CONTRACTS §C1/§C3 types). Unmappable or invalid cells are
 * collected as row-level `RowError`s and never silently dropped; a sibling
 * cell's failure never discards the row's other values.
 */

export interface CustomFieldSpec {
  key: string;
  type: 'text' | 'number' | 'date' | 'select' | 'user';
  options: string[] | null;
}

export interface MappingContext {
  /** Lead-entity custom fields keyed by snake_case key. */
  customFields: Map<string, CustomFieldSpec>;
  /** Lead-status id keyed by lowercased label. */
  statusByLabel: Map<string, string>;
  /** User id keyed by lowercased email. */
  userByEmail: Map<string, string>;
  /** Valid user ids (lets an `owner`/`user` cell carry a raw uuid). */
  userById: Set<string>;
}

export interface MappedLead {
  name: string | null;
  url: string | null;
  description: string | null;
  dnc: boolean | null;
  statusId: string | null;
  ownerId: string | null;
  custom: Record<string, unknown>;
}

export interface MappedContact {
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
}

export interface MappedRow {
  lead: MappedLead;
  contact: MappedContact;
  errors: RowError[];
}

// --- Target parsing ---------------------------------------------------------

const LEAD_FIELD_SET = new Set<string>(LEAD_TARGET_FIELDS);
const CONTACT_FIELD_SET = new Set<string>(CONTACT_TARGET_FIELDS);

/** Parse a target string (`ignore` | `lead.x` | `contact.x` | `custom.key`). */
export function parseTarget(target: string): MappingTarget | null {
  if (target === 'ignore') return { kind: 'ignore' };
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

/**
 * Config-time validation: bad target syntax and custom keys that do not exist in
 * `custom_field_defs`. Returned as human strings for a `VALIDATION_FAILED` reply
 * — these would otherwise fail identically on every row.
 */
export function validateMappingTargets(mapping: ImportMapping, ctx: MappingContext): string[] {
  const errors: string[] = [];
  for (const col of mapping.columns) {
    const t = parseTarget(col.target);
    if (t === null) {
      errors.push(`invalid target "${col.target}" for column "${col.source}"`);
      continue;
    }
    if (t.kind === 'custom' && !ctx.customFields.has(t.key)) {
      errors.push(`unknown custom field "custom.${t.key}" for column "${col.source}"`);
    }
  }
  return errors;
}

// --- Header index -----------------------------------------------------------

export interface HeaderIndex {
  index: Map<string, number>;
  duplicates: string[];
}

/** Map trimmed header → first column index; report duplicate header names. */
export function buildHeaderIndex(headers: string[]): HeaderIndex {
  const index = new Map<string, number>();
  const seen = new Set<string>();
  const duplicates: string[] = [];
  headers.forEach((h, i) => {
    const key = h.trim();
    if (index.has(key)) {
      if (!seen.has(key)) {
        duplicates.push(key);
        seen.add(key);
      }
      return; // first occurrence wins
    }
    index.set(key, i);
  });
  return { index, duplicates };
}

// --- Cell coercion ----------------------------------------------------------

type Coerced = { ok: true; value: unknown } | { ok: false; code: string };

const NUMBER_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T/;
const TRUE_SET = new Set(['true', '1', 'yes', 'y', 't']);
const FALSE_SET = new Set(['false', '0', 'no', 'n', 'f']);

function coerceNumber(s: string): Coerced {
  if (!NUMBER_RE.test(s)) return { ok: false, code: 'invalid_number' };
  const n = Number(s);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, code: 'invalid_number' };
}

function coerceDate(s: string): Coerced {
  if (DATE_RE.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s) {
      return { ok: true, value: s };
    }
    return { ok: false, code: 'invalid_date' };
  }
  if (DATETIME_RE.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return { ok: true, value: d.toISOString().slice(0, 10) };
  }
  return { ok: false, code: 'invalid_date' };
}

function coerceBool(s: string): Coerced {
  const lower = s.toLowerCase();
  if (TRUE_SET.has(lower)) return { ok: true, value: true };
  if (FALSE_SET.has(lower)) return { ok: true, value: false };
  return { ok: false, code: 'invalid_bool' };
}

function coerceSelect(s: string, options: string[] | null): Coerced {
  if (options === null) return { ok: false, code: 'not_in_options' };
  const match = options.find((o) => o.toLowerCase() === s.toLowerCase());
  return match === undefined ? { ok: false, code: 'not_in_options' } : { ok: true, value: match };
}

function resolveUser(s: string, ctx: MappingContext): Coerced {
  const byEmail = ctx.userByEmail.get(s.toLowerCase());
  if (byEmail !== undefined) return { ok: true, value: byEmail };
  if (ctx.userById.has(s)) return { ok: true, value: s };
  return { ok: false, code: 'unknown_user' };
}

function coerceCustom(spec: CustomFieldSpec, s: string, ctx: MappingContext): Coerced {
  switch (spec.type) {
    case 'text':
      return { ok: true, value: s };
    case 'number':
      return coerceNumber(s);
    case 'date':
      return coerceDate(s);
    case 'select':
      return coerceSelect(s, spec.options);
    case 'user':
      return resolveUser(s, ctx);
  }
}

// --- Row mapping ------------------------------------------------------------

function err(column: string, target: string, code: string, value: string): RowError {
  return { column, target, code, message: `${code} for ${target}`, value };
}

/**
 * Map one CSV record to typed lead/contact fields. Empty cells resolve to `null`
 * (a missing optional, never an error); only non-empty invalid values produce a
 * `RowError`. Requiredness (a lead needs a name to be *created*) is enforced
 * later by the planner, since a dedupe match can attach a contact to an existing
 * lead with no name of its own.
 */
export function mapRecord(
  record: string[],
  index: Map<string, number>,
  mapping: ImportMapping,
  ctx: MappingContext,
): MappedRow {
  const lead: MappedLead = {
    name: null,
    url: null,
    description: null,
    dnc: null,
    statusId: null,
    ownerId: null,
    custom: {},
  };
  const contact: MappedContact = { name: null, title: null, email: null, phone: null };
  const errors: RowError[] = [];

  for (const col of mapping.columns) {
    const target = parseTarget(col.target);
    if (target === null || target.kind === 'ignore') continue;
    const i = index.get(col.source.trim());
    if (i === undefined) continue; // header not present in this file
    const raw = (record[i] ?? '').trim();
    if (raw === '') continue; // empty → leave as null / unset

    if (target.kind === 'lead') {
      switch (target.field) {
        case 'name':
          lead.name = raw;
          break;
        case 'url':
          lead.url = raw;
          break;
        case 'description':
          lead.description = raw;
          break;
        case 'dnc': {
          const c = coerceBool(raw);
          if (c.ok) lead.dnc = c.value as boolean;
          else errors.push(err(col.source, col.target, c.code, raw));
          break;
        }
        case 'status': {
          const id = ctx.statusByLabel.get(raw.toLowerCase());
          if (id !== undefined) lead.statusId = id;
          else errors.push(err(col.source, col.target, 'unknown_status', raw));
          break;
        }
        case 'owner': {
          const c = resolveUser(raw, ctx);
          if (c.ok) lead.ownerId = c.value as string;
          else errors.push(err(col.source, col.target, c.code, raw));
          break;
        }
      }
      continue;
    }

    if (target.kind === 'contact') {
      switch (target.field) {
        case 'name':
          contact.name = raw;
          break;
        case 'title':
          contact.title = raw;
          break;
        case 'phone':
          contact.phone = raw;
          break;
        case 'email': {
          const lower = raw.toLowerCase();
          if (EMAIL_RE.test(lower)) contact.email = lower;
          else errors.push(err(col.source, col.target, 'invalid_email', raw));
          break;
        }
      }
      continue;
    }

    // custom
    const spec = ctx.customFields.get(target.key);
    if (spec === undefined) {
      errors.push(err(col.source, col.target, 'unknown_custom_field', raw));
      continue;
    }
    const c = coerceCustom(spec, raw, ctx);
    if (c.ok) lead.custom[spec.key] = c.value;
    else errors.push(err(col.source, col.target, c.code, raw));
  }

  return { lead, contact, errors };
}
