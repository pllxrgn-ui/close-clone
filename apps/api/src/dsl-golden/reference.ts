/**
 * Independent reference evaluator for the Smart View DSL golden set (Task 1d).
 *
 * This module derives the expected lead-id set for a parsed AST by evaluating
 * predicate semantics **directly over the loaded fixture rows in TypeScript** —
 * it never calls the compiler and never inspects compiler SQL/snapshots. It is
 * the independent oracle the DB-executed compiler output is compared against
 * (CONTRACTS §C3). Where the compiler reads denormalized hot columns, this
 * evaluator recomputes the same fact from the activity spine, so a wrong
 * denormalization mapping surfaces as a mismatch rather than being masked.
 *
 * Relative-date resolution ("execution time, org timezone" — C3) is implemented
 * here with a self-contained `Intl`-based timezone resolver rather than importing
 * the compiler's `datetime.ts` (which is not part of the package's public
 * surface). The lead-set logic — comparison direction, null handling, EXISTS
 * semantics, membership expansion, dollar conversion — is entirely independent.
 */
import type {
  Expr,
  FieldRef,
  MembershipValue,
  Relative,
  RelativeUnit,
  ScalarValue,
} from '@switchboard/shared/dsl';

// --- Fixture record shapes (subset the evaluator needs) --------------------

export interface RefLead {
  id: string;
  name: string;
  description: string;
  status: string;
  ownerId: string;
  custom: Record<string, string | number | boolean>;
  dnc: boolean;
  createdAt: string;
  lastContactedAt: string | null;
  lastInboundAt: string | null;
  nextTaskDueAt: string | null;
  lastCallAt: string | null;
  lastEmailAt: string | null;
  lastSmsAt: string | null;
}

export interface RefContact {
  id: string;
  leadId: string;
  title: string | null;
  emails: { email: string; type: string }[];
  phones: { phone: string; type: string }[];
}

export interface RefOpportunity {
  leadId: string;
  valueCents: number;
  stage: string;
  closeDate: string | null;
}

export interface RefActivity {
  leadId: string;
  type: string;
  occurredAt: string;
}

export interface RefDataset {
  leads: RefLead[];
  contacts: RefContact[];
  opportunities: RefOpportunity[];
  activities: RefActivity[];
}

/** A seeded sequence enrollment (Task 1d adds these; fixtures carry none). */
export interface RefEnrollment {
  leadId: string;
  sequenceName: string;
  state: 'active' | 'paused' | 'finished' | 'unenrolled';
  createdAt: string;
}

export interface RefContext {
  readonly currentUserId: string;
  readonly orgTimezone: string;
  readonly now: Date;
}

// --- Timezone-aware relative-date resolver (independent of the compiler) ----

interface LocalParts {
  y: number;
  mo: number;
  da: number;
  h: number;
  mi: number;
  s: number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

function partsInTz(date: Date, tz: string): LocalParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  const hourStr = out.hour ?? '0';
  const hour = hourStr === '24' ? 0 : Number(hourStr);
  return {
    y: Number(out.year),
    mo: Number(out.month),
    da: Number(out.day),
    h: hour,
    mi: Number(out.minute),
    s: Number(out.second),
  };
}

function offsetMs(date: Date, tz: string): number {
  const p = partsInTz(date, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.da, p.h, p.mi, p.s);
  return asUtc - date.getTime();
}

function instantFromLocal(p: LocalParts, tz: string): Date {
  const guessUtc = Date.UTC(p.y, p.mo - 1, p.da, p.h, p.mi, p.s);
  const off1 = offsetMs(new Date(guessUtc), tz);
  let instant = guessUtc - off1;
  const off2 = offsetMs(new Date(instant), tz);
  if (off2 !== off1) instant = guessUtc - off2;
  return new Date(instant);
}

function daysInMonth(y: number, mo1: number): number {
  return new Date(Date.UTC(y, mo1, 0)).getUTCDate();
}

function weekdayInTz(date: Date, tz: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  return idx < 0 ? 0 : idx;
}

function startOfDay(now: Date, tz: string): Date {
  const p = partsInTz(now, tz);
  return instantFromLocal({ ...p, h: 0, mi: 0, s: 0 }, tz);
}

function startOfMonth(now: Date, tz: string): Date {
  const p = partsInTz(now, tz);
  return instantFromLocal({ ...p, da: 1, h: 0, mi: 0, s: 0 }, tz);
}

function startOfWeek(now: Date, tz: string): Date {
  const dow = weekdayInTz(now, tz);
  const sinceMonday = dow === 0 ? 6 : dow - 1;
  return new Date(startOfDay(now, tz).getTime() - sinceMonday * DAY);
}

function subMonths(now: Date, n: number, tz: string): Date {
  const p = partsInTz(now, tz);
  let monthIdx = p.mo - 1 - n;
  const y = p.y + Math.floor(monthIdx / 12);
  monthIdx = ((monthIdx % 12) + 12) % 12;
  const da = Math.min(p.da, daysInMonth(y, monthIdx + 1));
  return instantFromLocal({ y, mo: monthIdx + 1, da, h: p.h, mi: p.mi, s: p.s }, tz);
}

function subAbsolute(now: Date, n: number, unit: Exclude<RelativeUnit, 'mo'>): Date {
  const per = unit === 'h' ? HOUR : unit === 'd' ? DAY : WEEK;
  return new Date(now.getTime() - n * per);
}

function resolveWithin(n: number, unit: RelativeUnit, now: Date, tz: string): number {
  const d = unit === 'mo' ? subMonths(now, n, tz) : subAbsolute(now, n, unit);
  return d.getTime();
}

function resolveScalarInstant(value: ScalarValue, ctx: RefContext): number {
  if (value.kind === 'reldate') {
    const rel = value.rel;
    if (rel.form === 'named') {
      switch (rel.name) {
        case 'today':
          return startOfDay(ctx.now, ctx.orgTimezone).getTime();
        case 'this_week':
          return startOfWeek(ctx.now, ctx.orgTimezone).getTime();
        case 'this_month':
          return startOfMonth(ctx.now, ctx.orgTimezone).getTime();
      }
    }
    return resolveWithin(rel.n, rel.unit, ctx.now, ctx.orgTimezone);
  }
  // date literal ('YYYY-MM-DD' → midnight UTC, matching a UTC session cast).
  if (value.kind === 'date' || value.kind === 'string') {
    return Date.parse(value.value);
  }
  throw new Error(`reference: non-date value kind "${value.kind}" in a date comparison`);
}

/** Test-visible anchor resolution (lets the suite pin fixed-ctx instants). */
export function resolveReldateInstant(rel: Relative, ctx: RefContext): number {
  return resolveScalarInstant({ kind: 'reldate', rel }, ctx);
}

// --- Comparison primitives --------------------------------------------------

type OrderCmp = '=' | '!=' | '<' | '<=' | '>' | '>=';

function orderCompare(a: number, b: number, cmp: OrderCmp): boolean {
  switch (cmp) {
    case '=':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
  }
}

function textCompare(haystack: string, cmp: string, needle: string): boolean {
  switch (cmp) {
    case '=':
      return haystack === needle;
    case '!=':
      return haystack !== needle;
    case 'contains':
      return haystack.toLowerCase().includes(needle.toLowerCase());
    case 'starts_with':
      return haystack.toLowerCase().startsWith(needle.toLowerCase());
    default:
      return false;
  }
}

// --- Dataset index ----------------------------------------------------------

export class ReferenceEvaluator {
  private readonly contactsByLead = new Map<string, RefContact[]>();
  private readonly oppsByLead = new Map<string, RefOpportunity[]>();
  private readonly actTypesByLead = new Map<string, Map<string, string[]>>();
  private readonly enrollByLead = new Map<string, RefEnrollment[]>();

  constructor(
    private readonly dataset: RefDataset,
    private readonly ctx: RefContext,
    enrollments: RefEnrollment[] = [],
  ) {
    for (const c of dataset.contacts) push(this.contactsByLead, c.leadId, c);
    for (const o of dataset.opportunities) push(this.oppsByLead, o.leadId, o);
    for (const a of dataset.activities) {
      let byType = this.actTypesByLead.get(a.leadId);
      if (!byType) {
        byType = new Map();
        this.actTypesByLead.set(a.leadId, byType);
      }
      push(byType, a.type, a.occurredAt);
    }
    for (const e of enrollments) push(this.enrollByLead, e.leadId, e);
  }

  /** Expected set of matching lead ids for a parsed AST. */
  evaluate(node: Expr): Set<string> {
    const out = new Set<string>();
    for (const lead of this.dataset.leads) {
      if (this.match(lead, node)) out.add(lead.id);
    }
    return out;
  }

  private match(lead: RefLead, node: Expr): boolean {
    switch (node.kind) {
      case 'and':
        return this.match(lead, node.left) && this.match(lead, node.right);
      case 'or':
        return this.match(lead, node.left) || this.match(lead, node.right);
      case 'not':
        return !this.match(lead, node.expr);
      case 'field':
        return this.field(lead, node.field, node.cmp, node.value);
      case 'presence':
        return this.presence(lead, node.field, node.op);
      case 'membership':
        return this.membership(lead, node.field, node.values);
      case 'activity':
        return this.activity(lead, node);
      case 'text':
        return this.text(lead, node.query);
    }
  }

  // --- field cmp value ------------------------------------------------------

  private field(lead: RefLead, field: FieldRef, cmp: string, value: ScalarValue): boolean {
    if (field.kind === 'custom') {
      return this.customField(lead, field.key, field.type, cmp, value);
    }
    return this.builtinField(lead, field.name, cmp, value);
  }

  private customField(
    lead: RefLead,
    key: string,
    type: string,
    cmp: string,
    value: ScalarValue,
  ): boolean {
    if (!(key in lead.custom)) return false; // NULL never satisfies a comparison
    const raw = lead.custom[key];
    if (type === 'number') {
      if (value.kind !== 'number') return false;
      return orderCompare(Number(raw), value.value, cmp as OrderCmp);
    }
    if (type === 'date') {
      return orderCompare(
        Date.parse(String(raw)),
        resolveScalarInstant(value, this.ctx),
        cmp as OrderCmp,
      );
    }
    // text / select / user → string comparison
    const s = value.kind === 'string' ? value.value : '';
    return textCompare(String(raw), cmp, s);
  }

  private builtinField(lead: RefLead, name: string, cmp: string, value: ScalarValue): boolean {
    switch (name) {
      case 'name':
        return textCompare(lead.name, cmp, value.kind === 'string' ? value.value : '');
      case 'dnc':
        return value.kind === 'bool'
          ? orderCompare(lead.dnc ? 1 : 0, value.value ? 1 : 0, cmp as OrderCmp)
          : false;
      case 'owner':
        return textCompare(lead.ownerId, cmp, this.scalarText(value));
      case 'status':
        return textCompare(lead.status, cmp, value.kind === 'string' ? value.value : '');
      case 'created':
        return orderCompare(
          Date.parse(lead.createdAt),
          resolveScalarInstant(value, this.ctx),
          cmp as OrderCmp,
        );
      case 'updated':
        // updated_at is the DB load time (not a fixture column); only used with
        // is_set/is_not_set in the golden set, never a value comparison.
        return false;
      case 'last_contacted':
        return this.nullableDate(lead.lastContactedAt, cmp, value);
      case 'last_inbound':
        return this.nullableDate(lead.lastInboundAt, cmp, value);
      case 'next_task_due':
        return this.nullableDate(lead.nextTaskDueAt, cmp, value);
      case 'opportunity.value':
        return value.kind === 'number'
          ? this.opps(lead).some((o) =>
              orderCompare(o.valueCents, Math.round(value.value * 100), cmp as OrderCmp),
            )
          : false;
      case 'opportunity.stage':
        return this.opps(lead).some((o) =>
          textCompare(o.stage, cmp, value.kind === 'string' ? value.value : ''),
        );
      case 'opportunity.close_date': {
        // `close_date` is a DATE column; Postgres casts the pushed text param
        // (a full ISO instant for reldates) to DATE, i.e. truncates to the UTC
        // calendar date of the ISO string. Mirror that truncation here.
        const day = Math.floor(resolveScalarInstant(value, this.ctx) / DAY) * DAY;
        return this.opps(lead).some(
          (o) =>
            o.closeDate !== null && orderCompare(Date.parse(o.closeDate), day, cmp as OrderCmp),
        );
      }
      case 'contact.title':
        return this.contacts(lead).some(
          (c) =>
            c.title !== null &&
            textCompare(c.title, cmp, value.kind === 'string' ? value.value : ''),
        );
      case 'contact.email':
        return this.contactArrayField(
          lead,
          'email',
          cmp,
          value.kind === 'string' ? value.value : '',
        );
      case 'contact.phone':
        return this.contactArrayField(
          lead,
          'phone',
          cmp,
          value.kind === 'string' ? value.value : '',
        );
      default:
        throw new Error(`reference: unsupported builtin field "${name}"`);
    }
  }

  private nullableDate(col: string | null, cmp: string, value: ScalarValue): boolean {
    if (col === null) return false;
    return orderCompare(Date.parse(col), resolveScalarInstant(value, this.ctx), cmp as OrderCmp);
  }

  private scalarText(value: ScalarValue): string {
    return value.kind === 'string' ? value.value : '';
  }

  /**
   * Mirrors the compiler's contact jsonb semantics: `=` / contains / starts_with
   * match "some contact entry"; `!=` matches "no contact entry equals" (compiler
   * emits `NOT EXISTS(... @> ...)`).
   */
  private contactArrayField(
    lead: RefLead,
    key: 'email' | 'phone',
    cmp: string,
    needle: string,
  ): boolean {
    const entries = this.contacts(lead).flatMap((c) =>
      key === 'email' ? c.emails.map((e) => e.email) : c.phones.map((p) => p.phone),
    );
    if (cmp === '!=') return !entries.some((v) => v === needle);
    return entries.some((v) => textCompare(v, cmp, needle));
  }

  // --- presence (is_set / is_not_set) --------------------------------------

  private presence(lead: RefLead, field: FieldRef, op: 'is_set' | 'is_not_set'): boolean {
    const set = this.isSet(lead, field);
    return op === 'is_set' ? set : !set;
  }

  private isSet(lead: RefLead, field: FieldRef): boolean {
    if (field.kind === 'custom') return field.key in lead.custom;
    switch (field.name) {
      case 'name':
      case 'status':
      case 'owner':
      case 'created':
      case 'updated':
      case 'dnc':
        return true; // NOT NULL columns in the loaded set
      case 'last_contacted':
        return lead.lastContactedAt !== null;
      case 'last_inbound':
        return lead.lastInboundAt !== null;
      case 'next_task_due':
        return lead.nextTaskDueAt !== null;
      case 'opportunity.value':
      case 'opportunity.stage':
      case 'opportunity.close_date':
        return this.opps(lead).length > 0;
      case 'contact.title':
        return this.contacts(lead).some((c) => c.title !== null);
      case 'contact.email':
        return this.contacts(lead).some((c) => c.emails.length > 0);
      case 'contact.phone':
        return this.contacts(lead).some((c) => c.phones.length > 0);
      default:
        throw new Error(`reference: unsupported presence field "${field.name}"`);
    }
  }

  // --- membership (field in (...)) -----------------------------------------

  private membership(lead: RefLead, field: FieldRef, values: MembershipValue[]): boolean {
    return values.some((v) => {
      if (v.kind === 'me')
        return this.field(lead, field, '=', { kind: 'string', value: this.ctx.currentUserId });
      if (v.kind === 'bool') return this.field(lead, field, '=', { kind: 'bool', value: v.value });
      if (v.kind === 'number')
        return this.field(lead, field, '=', { kind: 'number', value: v.value });
      return this.field(lead, field, '=', { kind: 'string', value: v.value });
    });
  }

  // --- activity predicates (derived from the spine, not denorm columns) ----

  private activity(lead: RefLead, node: Extract<Expr, { kind: 'activity' }>): boolean {
    const cutoff = node.within
      ? resolveWithin(node.within.n, node.within.unit, this.ctx.now, this.ctx.orgTimezone)
      : null;
    const present = this.hasActivity(lead, node.activity, node.sequenceName, cutoff);
    return node.op === 'has' ? present : !present;
  }

  private hasActivity(
    lead: RefLead,
    activity: string,
    sequenceName: string | undefined,
    cutoff: number | null,
  ): boolean {
    if (activity === 'in_sequence') {
      const name = sequenceName ?? '';
      return (this.enrollByLead.get(lead.id) ?? []).some(
        (e) =>
          e.sequenceName === name &&
          (e.state === 'active' || e.state === 'paused') &&
          (cutoff === null || Date.parse(e.createdAt) >= cutoff),
      );
    }
    const types = ACTIVITY_TYPE_GROUPS[activity];
    if (!types) throw new Error(`reference: unsupported activity "${activity}"`);
    const byType = this.actTypesByLead.get(lead.id);
    if (!byType) return false;
    for (const t of types) {
      const occ = byType.get(t);
      if (!occ) continue;
      if (cutoff === null) return true;
      if (occ.some((o) => Date.parse(o) >= cutoff)) return true;
    }
    return false;
  }

  // --- text (FTS) -----------------------------------------------------------

  private text(lead: RefLead, query: string): boolean {
    // websearch_to_tsquery('english', ...) ANDs the query words together; golden
    // FTS cases use stem-stable proper-noun / industry tokens so a plain
    // whole-token, case-insensitive all-words-present check matches Postgres.
    // `search_tsv` is generated from name + description (C1 schema).
    const docTokens = tokenize(`${lead.name} ${lead.description}`);
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return false;
    for (const t of queryTokens) {
      if (!docTokens.has(t)) return false;
    }
    return true;
  }

  private opps(lead: RefLead): RefOpportunity[] {
    return this.oppsByLead.get(lead.id) ?? [];
  }

  private contacts(lead: RefLead): RefContact[] {
    return this.contactsByLead.get(lead.id) ?? [];
  }
}

// Activity-type groupings: DSL activity keyword → contributing spine event types
// (CONTRACTS §C4). Must match how the compiler resolves each keyword.
const ACTIVITY_TYPE_GROUPS: Record<string, string[] | undefined> = {
  call: ['call_logged', 'call_missed', 'voicemail_received'],
  email: ['email_sent', 'email_received'],
  inbound_email: ['email_received'],
  sms: ['sms_sent', 'sms_received'],
  note: ['note_added'],
  task_completed: ['task_completed'],
  sequence: ['sequence_enrolled'],
};

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
