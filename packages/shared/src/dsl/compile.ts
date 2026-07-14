/**
 * Smart View compiler (CONTRACTS §C3): typed AST → parameterized SQL.
 *
 * Hard invariant (C3): **parameters only**. Every user-supplied literal — strings,
 * numbers, dates, sequence names, custom-field keys, cursor values, limits — is
 * emitted as a `$n` placeholder via the single {@link ParamBuilder.push} path.
 * Identifiers (columns/operators) come exclusively from fixed internal maps;
 * custom keys are looked up against the catalog whitelist and bound as params to
 * jsonb `->>` / `?`, never spliced into the SQL text.
 *
 * Targets the C1 schema (`leads` + denormalized columns). Activity predicates
 * prefer denormalized columns where they map (has_call → last_call_at), falling
 * back to EXISTS subqueries otherwise. Every query emits keyset pagination +
 * LIMIT.
 */
import type { Ast, CustomFieldDef, Expr, FieldRef, ScalarValue } from './ast.ts';
import { resolveRelative, resolveWithin } from './datetime.ts';
import type { ValueCmp } from './fields.ts';

export interface CompileContext {
  /** The querying user; binds `me` in membership lists (C3). */
  readonly currentUserId: string;
  /** Org timezone; relative dates resolve here at execution time (C3). */
  readonly orgTimezone: string;
  /** Custom field catalog (C1 shape) — the whitelist for `custom.<key>`. */
  readonly fieldCatalog: readonly CustomFieldDef[];
  /** Execution "now"; relative-date anchor. */
  readonly now: Date;
}

export const SORTABLE_FIELDS = [
  'created',
  'updated',
  'name',
  'last_contacted',
  'last_inbound',
  'next_task_due',
] as const;
export type SortField = (typeof SORTABLE_FIELDS)[number];

export interface SortSpec {
  readonly field: SortField;
  readonly direction: 'asc' | 'desc';
}

export interface Cursor {
  /** Last row's sort-column value from the previous page. */
  readonly sortValue: string | number | boolean | null;
  /** Last row's id from the previous page (keyset tiebreak). */
  readonly id: string;
}

export interface CompileOptions {
  readonly sort?: SortSpec;
  readonly cursor?: Cursor;
  readonly limit?: number;
}

export interface CompiledQuery {
  readonly sql: string;
  readonly params: unknown[];
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

const SQL_CMP: Record<ValueCmp, string> = {
  '=': '=',
  '!=': '<>',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  contains: 'ILIKE',
  starts_with: 'ILIKE',
};

const LEADS_COLUMN: Record<string, string> = {
  name: 'leads.name',
  owner: 'leads.owner_id',
  created: 'leads.created_at',
  updated: 'leads.updated_at',
  last_contacted: 'leads.last_contacted_at',
  last_inbound: 'leads.last_inbound_at',
  next_task_due: 'leads.next_task_due_at',
  dnc: 'leads.dnc',
};

const SORT_COLUMN: Record<SortField, string> = {
  created: 'leads.created_at',
  updated: 'leads.updated_at',
  name: 'leads.name',
  last_contacted: 'leads.last_contacted_at',
  last_inbound: 'leads.last_inbound_at',
  next_task_due: 'leads.next_task_due_at',
};

const ACTIVITY_DENORM: Record<string, string> = {
  call: 'leads.last_call_at',
  email: 'leads.last_email_at',
  inbound_email: 'leads.last_inbound_at',
  sms: 'leads.last_sms_at',
};

const ACTIVITY_EVENT_TYPE: Record<string, string> = {
  note: 'note_added',
  task_completed: 'task_completed',
  sequence: 'sequence_enrolled',
};

class ParamBuilder {
  readonly params: unknown[] = [];
  /** The one and only place a user value enters the SQL. Returns its `$n`. */
  push(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
}

class Compiler {
  private readonly p = new ParamBuilder();
  private readonly customKeys: Set<string>;

  constructor(private readonly ctx: CompileContext) {
    this.customKeys = new Set(
      ctx.fieldCatalog.filter((d) => d.entity === 'lead').map((d) => d.key),
    );
  }

  compile(ast: Ast, options: CompileOptions): CompiledQuery {
    const sort: SortSpec = options.sort ?? { field: 'created', direction: 'desc' };
    if (!(sort.field in SORT_COLUMN)) {
      throw new Error(`invalid sort field "${sort.field}"`);
    }
    const dir = sort.direction === 'asc' ? 'ASC' : 'DESC';
    const keysetCmp = sort.direction === 'asc' ? '>' : '<';
    const sortCol = SORT_COLUMN[sort.field];

    // Predicate params must be pushed before cursor/limit params so that
    // placeholder numbering matches textual order in the final SQL.
    const predicate = this.emit(ast);

    const where = ['leads.deleted_at IS NULL', `(${predicate})`];
    if (options.cursor) {
      where.push(
        `(${sortCol}, leads.id) ${keysetCmp} (${this.p.push(options.cursor.sortValue)}, ${this.p.push(options.cursor.id)})`,
      );
    }

    const limit = clampLimit(options.limit);
    const sql =
      `SELECT leads.id\n` +
      `FROM leads\n` +
      `WHERE ${where.join(' AND ')}\n` +
      `ORDER BY ${sortCol} ${dir}, leads.id ${dir}\n` +
      `LIMIT ${this.p.push(limit)}`;

    return { sql, params: this.p.params };
  }

  private emit(node: Expr): string {
    switch (node.kind) {
      case 'and':
        return `(${this.emit(node.left)} AND ${this.emit(node.right)})`;
      case 'or':
        return `(${this.emit(node.left)} OR ${this.emit(node.right)})`;
      case 'not':
        return `(NOT ${this.emit(node.expr)})`;
      case 'field':
        return this.comparison(node.field, node.cmp, node.value);
      case 'presence':
        return this.presence(node.field, node.op);
      case 'membership':
        return `(${node.values
          .map((v) =>
            v.kind === 'me'
              ? this.comparison(node.field, '=', { kind: 'me' })
              : this.comparison(node.field, '=', v),
          )
          .join(' OR ')})`;
      case 'activity':
        return this.activity(node);
      case 'text':
        return `leads.search_tsv @@ websearch_to_tsquery('english', ${this.p.push(node.query)})`;
    }
  }

  /** Push the concrete comparison value (or `me` → currentUserId). */
  private pushValue(value: ScalarValue | { kind: 'me' }): string {
    switch (value.kind) {
      case 'me':
        return this.p.push(this.ctx.currentUserId);
      case 'string':
        return this.p.push(value.value);
      case 'number':
        return this.p.push(value.value);
      case 'bool':
        return this.p.push(value.value);
      case 'date':
        return this.p.push(value.value);
      case 'reldate':
        return this.p.push(
          resolveRelative(value.rel, this.ctx.now, this.ctx.orgTimezone).toISOString(),
        );
    }
  }

  private comparison(field: FieldRef, cmp: ValueCmp, value: ScalarValue | { kind: 'me' }): string {
    const textLike = cmp === 'contains' || cmp === 'starts_with';
    const strVal = value.kind === 'string' ? value.value : '';

    if (field.kind === 'custom') {
      if (!this.customKeys.has(field.key)) {
        throw new Error(`unknown custom field "custom.${field.key}"`);
      }
      const base = `(leads.custom ->> ${this.p.push(field.key)})`;
      const accessor =
        field.type === 'number'
          ? `${base}::numeric`
          : field.type === 'date'
            ? `${base}::timestamptz`
            : base;
      return textLike
        ? `${accessor} ILIKE ${this.p.push(pattern(cmp, strVal))}`
        : `${accessor} ${SQL_CMP[cmp]} ${this.pushValue(value)}`;
    }

    const name = field.name;
    if (name in LEADS_COLUMN) {
      const col = LEADS_COLUMN[name] as string;
      return textLike
        ? `${col} ILIKE ${this.p.push(pattern(cmp, strVal))}`
        : `${col} ${SQL_CMP[cmp]} ${this.pushValue(value)}`;
    }

    switch (name) {
      case 'status':
        return `leads.status_id ${SQL_CMP[cmp]} (SELECT id FROM lead_statuses WHERE label = ${this.pushValue(value)})`;
      case 'opportunity.value':
        return `EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id = leads.id AND o.value_cents ${SQL_CMP[cmp]} ${this.pushValue(value)})`;
      case 'opportunity.close_date':
        return `EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id = leads.id AND o.close_date ${SQL_CMP[cmp]} ${this.pushValue(value)})`;
      case 'opportunity.stage':
        return `EXISTS (SELECT 1 FROM opportunities o JOIN opportunity_stages st ON st.id = o.stage_id WHERE o.lead_id = leads.id AND st.label ${SQL_CMP[cmp]} ${this.pushValue(value)})`;
      case 'contact.title':
        return textLike
          ? `EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id = leads.id AND c.deleted_at IS NULL AND c.title ILIKE ${this.p.push(pattern(cmp, strVal))})`
          : `EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id = leads.id AND c.deleted_at IS NULL AND c.title ${SQL_CMP[cmp]} ${this.pushValue(value)})`;
      case 'contact.email':
        return this.contactJsonb('emails', 'email', cmp, strVal);
      case 'contact.phone':
        return this.contactJsonb('phones', 'phone', cmp, strVal);
      default:
        // Unreachable: parser only yields known builtins.
        throw new Error(`unsupported field "${name}"`);
    }
  }

  private contactJsonb(
    col: 'emails' | 'phones',
    jsonKey: 'email' | 'phone',
    cmp: ValueCmp,
    strVal: string,
  ): string {
    if (cmp === 'contains' || cmp === 'starts_with') {
      return `EXISTS (SELECT 1 FROM contacts c CROSS JOIN LATERAL jsonb_array_elements(c.${col}) AS el WHERE c.lead_id = leads.id AND c.deleted_at IS NULL AND el ->> ${this.p.push(jsonKey)} ILIKE ${this.p.push(pattern(cmp, strVal))})`;
    }
    const containment = `EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id = leads.id AND c.deleted_at IS NULL AND c.${col} @> ${this.p.push(JSON.stringify([{ [jsonKey]: strVal }]))}::jsonb)`;
    return cmp === '!=' ? `NOT ${containment}` : containment;
  }

  private presence(field: FieldRef, op: 'is_set' | 'is_not_set'): string {
    const set = op === 'is_set';
    if (field.kind === 'custom') {
      if (!this.customKeys.has(field.key)) {
        throw new Error(`unknown custom field "custom.${field.key}"`);
      }
      const exists = `(leads.custom ? ${this.p.push(field.key)})`;
      return set ? exists : `NOT ${exists}`;
    }
    const name = field.name;
    if (name in LEADS_COLUMN) {
      return `${LEADS_COLUMN[name]} IS ${set ? 'NOT NULL' : 'NULL'}`;
    }
    switch (name) {
      case 'status':
        return `leads.status_id IS ${set ? 'NOT NULL' : 'NULL'}`;
      case 'opportunity.value':
      case 'opportunity.stage':
      case 'opportunity.close_date': {
        const exists = `EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id = leads.id)`;
        return set ? exists : `NOT ${exists}`;
      }
      case 'contact.title': {
        const exists = `EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id = leads.id AND c.deleted_at IS NULL AND c.title IS NOT NULL)`;
        return set ? exists : `NOT ${exists}`;
      }
      case 'contact.email':
      case 'contact.phone': {
        const col = name === 'contact.email' ? 'emails' : 'phones';
        const exists = `EXISTS (SELECT 1 FROM contacts c WHERE c.lead_id = leads.id AND c.deleted_at IS NULL AND jsonb_array_length(c.${col}) > 0)`;
        return set ? exists : `NOT ${exists}`;
      }
      default:
        throw new Error(`unsupported field "${name}"`);
    }
  }

  private activity(node: Extract<Expr, { kind: 'activity' }>): string {
    const cutoff = node.within
      ? resolveWithin(
          node.within.n,
          node.within.unit,
          this.ctx.now,
          this.ctx.orgTimezone,
        ).toISOString()
      : null;
    const has = node.op === 'has';

    if (node.activity in ACTIVITY_DENORM) {
      const col = ACTIVITY_DENORM[node.activity] as string;
      if (cutoff !== null) {
        return has
          ? `${col} >= ${this.p.push(cutoff)}`
          : `(${col} IS NULL OR ${col} < ${this.p.push(cutoff)})`;
      }
      return `${col} IS ${has ? 'NOT NULL' : 'NULL'}`;
    }

    if (node.activity === 'in_sequence') {
      let inner = `SELECT 1 FROM sequence_enrollments se JOIN sequences sq ON sq.id = se.sequence_id WHERE se.lead_id = leads.id AND sq.name = ${this.p.push(node.sequenceName ?? '')} AND se.state IN ('active', 'paused')`;
      if (cutoff !== null) inner += ` AND se.created_at >= ${this.p.push(cutoff)}`;
      return has ? `EXISTS (${inner})` : `NOT EXISTS (${inner})`;
    }

    const eventType = ACTIVITY_EVENT_TYPE[node.activity] as string;
    let inner = `SELECT 1 FROM activities a WHERE a.lead_id = leads.id AND a.type = ${this.p.push(eventType)}`;
    if (cutoff !== null) inner += ` AND a.occurred_at >= ${this.p.push(cutoff)}`;
    return has ? `EXISTS (${inner})` : `NOT EXISTS (${inner})`;
  }
}

function pattern(cmp: ValueCmp, value: string): string {
  return cmp === 'contains' ? `%${value}%` : `${value}%`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Compile a typed AST to parameterized SQL + params (CONTRACTS §C3). */
export function compile(
  ast: Ast,
  ctx: CompileContext,
  options: CompileOptions = {},
): CompiledQuery {
  return new Compiler(ctx).compile(ast, options);
}
