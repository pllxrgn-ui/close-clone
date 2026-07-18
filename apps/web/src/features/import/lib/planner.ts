/*
 * Demo-mode dry-run planner — a faithful client port of the server engine
 * (services/imports/plan.ts + mapping.ts). It decides every row's disposition
 * (create / dedupe+action / error / empty), coerces cells per the lead
 * custom-field defs, and pre-assigns ids, writing NOTHING. The MSW /dry-run
 * handler runs this against a snapshot of the mock db so the counts + per-row
 * ledger match the shape the real POST /imports/:id/dry-run returns. Pure and
 * synchronous; the only non-determinism (id minting, fuzzy corpus) is injected.
 */
import { parseTarget } from './mapping.ts';
import { deriveDomains, normalizeName } from './normalize.ts';
import {
  emptyCounts,
  type DedupeConfig,
  type ImportMapping,
  type ImportPlan,
  type MatchType,
  type PlannedContact,
  type PlannedLead,
  type RowError,
  type RowPlan,
} from '../types.ts';

export interface CustomFieldSpec {
  key: string;
  type: 'text' | 'number' | 'date' | 'select' | 'user';
  options: string[] | null;
}

export interface PlanContext {
  customFields: Map<string, CustomFieldSpec>;
  statusByLabel: Map<string, string>;
  userByEmail: Map<string, string>;
  userById: Set<string>;
}

/** The pre-import snapshot the planner dedupes against (owned by the caller). */
export interface ExistingIndex {
  matchByEmail(email: string): string | null;
  matchByDomain(domain: string): string | null;
  matchByName(normalizedName: string, threshold: number): string | null;
  isSuppressed(email: string): boolean;
}

export interface PlanInput {
  /** All records, header first (as `parseCsvRecords` returns them). */
  records: string[][];
  mapping: ImportMapping;
  dedupe: DedupeConfig;
  ctx: PlanContext;
  existing: ExistingIndex;
  newLeadId: () => string;
  newContactId: () => string;
}

// ── Cell coercion (mirrors services/imports/mapping.ts) ─────────────────────
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
function resolveUser(s: string, ctx: PlanContext): Coerced {
  const byEmail = ctx.userByEmail.get(s.toLowerCase());
  if (byEmail !== undefined) return { ok: true, value: byEmail };
  if (ctx.userById.has(s)) return { ok: true, value: s };
  return { ok: false, code: 'unknown_user' };
}
function coerceCustom(spec: CustomFieldSpec, s: string, ctx: PlanContext): Coerced {
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

interface MappedLead {
  name: string | null;
  url: string | null;
  description: string | null;
  dnc: boolean | null;
  statusId: string | null;
  ownerId: string | null;
  custom: Record<string, unknown>;
}
interface MappedContact {
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
}
interface MappedRow {
  lead: MappedLead;
  contact: MappedContact;
  errors: RowError[];
}

function rowError(column: string, target: string, code: string, value: string): RowError {
  return { column, target, code, message: `${code} for ${target}`, value };
}

function buildHeaderIndex(headers: string[]): { index: Map<string, number>; duplicates: string[] } {
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
      return;
    }
    index.set(key, i);
  });
  return { index, duplicates };
}

function mapRecord(record: string[], index: Map<string, number>, input: PlanInput): MappedRow {
  const { ctx } = input;
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

  for (const col of input.mapping.columns) {
    const target = parseTarget(col.target);
    if (target === null || target.kind === 'ignore') continue;
    const i = index.get(col.source.trim());
    if (i === undefined) continue;
    const raw = (record[i] ?? '').trim();
    if (raw === '') continue;

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
          else errors.push(rowError(col.source, col.target, c.code, raw));
          break;
        }
        case 'status': {
          const id = ctx.statusByLabel.get(raw.toLowerCase());
          if (id !== undefined) lead.statusId = id;
          else errors.push(rowError(col.source, col.target, 'unknown_status', raw));
          break;
        }
        case 'owner': {
          const c = resolveUser(raw, ctx);
          if (c.ok) lead.ownerId = c.value as string;
          else errors.push(rowError(col.source, col.target, c.code, raw));
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
          else errors.push(rowError(col.source, col.target, 'invalid_email', raw));
          break;
        }
      }
      continue;
    }

    const spec = ctx.customFields.get(target.key);
    if (spec === undefined) {
      errors.push(rowError(col.source, col.target, 'unknown_custom_field', raw));
      continue;
    }
    const c = coerceCustom(spec, raw, ctx);
    if (c.ok) lead.custom[spec.key] = c.value;
    else errors.push(rowError(col.source, col.target, c.code, raw));
  }

  return { lead, contact, errors };
}

// ── Plan assembly ───────────────────────────────────────────────────────────
function contactHasData(m: MappedRow): boolean {
  const c = m.contact;
  return c.name !== null || c.email !== null || c.phone !== null || c.title !== null;
}
function buildPlannedLead(id: string, m: MappedRow): PlannedLead {
  const l = m.lead;
  return {
    id,
    name: l.name,
    url: l.url,
    description: l.description,
    dnc: l.dnc ?? false,
    statusId: l.statusId,
    ownerId: l.ownerId,
    custom: l.custom,
  };
}
function buildPlannedContact(id: string, m: MappedRow, suppressed: boolean): PlannedContact {
  const c = m.contact;
  const name = c.name ?? c.email ?? c.phone ?? c.title ?? 'Unknown';
  return { id, name, title: c.title, email: c.email, phone: c.phone, suppressed };
}
function missingNameError(): RowError {
  return {
    column: null,
    target: null,
    code: 'missing_lead_name',
    message: 'row has no lead name and no dedupe match to attach to',
    value: null,
  };
}
function isBlankRecord(record: string[]): boolean {
  return record.every((c) => c.trim() === '');
}

interface Match {
  leadId: string;
  matchType: MatchType;
}

export function buildPlan(input: PlanInput): ImportPlan {
  const { records, mapping, dedupe, existing, newLeadId, newContactId } = input;
  const warnings: string[] = [];
  const counts = emptyCounts();
  const rows: RowPlan[] = [];

  if (records.length === 0) {
    return { version: 1, counts, rows, warnings: ['file has no header row'] };
  }

  const [headerRecord, ...dataRecords] = records;
  const { index, duplicates } = buildHeaderIndex(headerRecord ?? []);
  for (const dup of duplicates) warnings.push(`duplicate header "${dup}" — first occurrence used`);
  for (const col of mapping.columns) {
    if (col.target !== 'ignore' && !index.has(col.source.trim())) {
      warnings.push(`mapped source header "${col.source}" is not present in the file`);
    }
  }

  const inFileEmail = new Map<string, string>();
  const inFileDomain = new Map<string, string>();
  const registerInFile = (leadId: string, email: string | null, domains: string[]): void => {
    if (email !== null && !inFileEmail.has(email)) inFileEmail.set(email, leadId);
    for (const d of domains) if (!inFileDomain.has(d)) inFileDomain.set(d, leadId);
  };

  const findMatch = (
    email: string | null,
    domains: string[],
    leadName: string | null,
  ): Match | null => {
    if (dedupe.matchOn.email && email !== null) {
      const hit = existing.matchByEmail(email);
      if (hit !== null) return { leadId: hit, matchType: 'email' };
    }
    if (dedupe.matchOn.domain) {
      for (const d of domains) {
        const hit = existing.matchByDomain(d);
        if (hit !== null) return { leadId: hit, matchType: 'domain' };
      }
    }
    if (dedupe.matchOn.fuzzyName && leadName !== null) {
      const hit = existing.matchByName(normalizeName(leadName), dedupe.fuzzyNameThreshold);
      if (hit !== null) return { leadId: hit, matchType: 'fuzzy-name' };
    }
    if (dedupe.matchOn.email && email !== null) {
      const hit = inFileEmail.get(email);
      if (hit !== undefined) return { leadId: hit, matchType: 'email' };
    }
    if (dedupe.matchOn.domain) {
      for (const d of domains) {
        const hit = inFileDomain.get(d);
        if (hit !== undefined) return { leadId: hit, matchType: 'domain' };
      }
    }
    return null;
  };

  const countMatch = (t: MatchType): void => {
    if (t === 'email') counts.matchedByEmail += 1;
    else if (t === 'domain') counts.matchedByDomain += 1;
    else counts.matchedByFuzzyName += 1;
  };
  const uncountMatch = (t: MatchType): void => {
    if (t === 'email') counts.matchedByEmail -= 1;
    else if (t === 'domain') counts.matchedByDomain -= 1;
    else counts.matchedByFuzzyName -= 1;
  };

  const baseRow = (rowIndex: number, outcome: RowPlan['outcome'], errors: RowError[]): RowPlan => ({
    rowIndex,
    outcome,
    action: null,
    matchType: null,
    leadCreated: false,
    contactCreated: false,
    targetLeadId: null,
    lead: null,
    contact: null,
    errors,
    suppressedEmails: [],
  });

  dataRecords.forEach((record, i) => {
    const rowIndex = i + 1;
    counts.totalRows += 1;

    if (isBlankRecord(record)) {
      counts.emptyRows += 1;
      rows.push(baseRow(rowIndex, 'empty', []));
      return;
    }
    const mapped = mapRecord(record, index, input);
    if (mapped.errors.length > 0) {
      counts.errorRows += 1;
      rows.push(baseRow(rowIndex, 'error', mapped.errors));
      return;
    }

    const email = mapped.contact.email;
    const domains = deriveDomains(mapped.lead.url, mapped.contact.email);
    const leadName = mapped.lead.name;
    const suppressed = email !== null && existing.isSuppressed(email);
    const hasContact = contactHasData(mapped);
    const match = findMatch(email, domains, leadName);

    if (match === null) {
      if (leadName === null) {
        counts.errorRows += 1;
        rows.push(baseRow(rowIndex, 'error', [missingNameError()]));
        return;
      }
      const leadId = newLeadId();
      const contact = hasContact ? buildPlannedContact(newContactId(), mapped, suppressed) : null;
      registerInFile(leadId, email, domains);
      counts.leadsCreated += 1;
      if (contact !== null) counts.contactsCreated += 1;
      if (contact !== null && suppressed) counts.suppressedContacts += 1;
      rows.push({
        rowIndex,
        outcome: 'create',
        action: null,
        matchType: null,
        leadCreated: true,
        contactCreated: contact !== null,
        targetLeadId: leadId,
        lead: buildPlannedLead(leadId, mapped),
        contact,
        errors: [],
        suppressedEmails: contact !== null && suppressed && email !== null ? [email] : [],
      });
      return;
    }

    countMatch(match.matchType);

    if (dedupe.action === 'skip') {
      counts.dedupeSkipped += 1;
      rows.push({
        ...baseRow(rowIndex, 'dedupe', []),
        action: 'skip',
        matchType: match.matchType,
        targetLeadId: match.leadId,
      });
      return;
    }

    if (dedupe.action === 'create-anyway') {
      if (leadName === null) {
        uncountMatch(match.matchType);
        counts.errorRows += 1;
        rows.push(baseRow(rowIndex, 'error', [missingNameError()]));
        return;
      }
      const leadId = newLeadId();
      const contact = hasContact ? buildPlannedContact(newContactId(), mapped, suppressed) : null;
      registerInFile(leadId, email, domains);
      counts.leadsCreated += 1;
      counts.dedupeCreateAnyway += 1;
      if (contact !== null) counts.contactsCreated += 1;
      if (contact !== null && suppressed) counts.suppressedContacts += 1;
      rows.push({
        rowIndex,
        outcome: 'create',
        action: 'create-anyway',
        matchType: match.matchType,
        leadCreated: true,
        contactCreated: contact !== null,
        targetLeadId: leadId,
        lead: buildPlannedLead(leadId, mapped),
        contact,
        errors: [],
        suppressedEmails: contact !== null && suppressed && email !== null ? [email] : [],
      });
      return;
    }

    // merge-fields: attach to the matched lead. An email match means the contact
    // already lives on that lead, so no new contact is created.
    counts.dedupeMerged += 1;
    const createContact = hasContact && match.matchType !== 'email';
    const contact = createContact ? buildPlannedContact(newContactId(), mapped, suppressed) : null;
    if (contact !== null) counts.contactsCreated += 1;
    if (contact !== null && suppressed) counts.suppressedContacts += 1;
    rows.push({
      rowIndex,
      outcome: 'dedupe',
      action: 'merge-fields',
      matchType: match.matchType,
      leadCreated: false,
      contactCreated: contact !== null,
      targetLeadId: match.leadId,
      lead: buildPlannedLead(match.leadId, mapped),
      contact,
      errors: [],
      suppressedEmails: contact !== null && suppressed && email !== null ? [email] : [],
    });
  });

  return { version: 1, counts, rows, warnings };
}
