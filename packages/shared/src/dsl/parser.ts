/**
 * Hand-written recursive-descent parser for the Smart View DSL (CONTRACTS §C3).
 *
 * Grammar (normative, C3):
 *   query      := orExpr
 *   orExpr     := andExpr ( "or" andExpr )*
 *   andExpr    := unary ( "and" unary )*
 *   unary      := "not" unary | "(" orExpr ")" | predicate
 *   predicate  := fieldPred | activityPred | membershipPred | textPred
 *
 * Keywords are case-insensitive. Type errors (comparator/value vs field type) are
 * raised as position-carrying {@link ParseError}s at parse time, per C3. The
 * parser only ever throws {@link ParseError}.
 */
import type { Ast, CustomFieldDef, FieldRef, MembershipValue, ScalarValue } from './ast.ts';
import { ACTIVITY_TYPES_DSL, NAMED_RELDATES, RELATIVE_UNITS, type RelativeUnit } from './ast.ts';
import { ParseError, type Position } from './errors.ts';
import {
  BUILTIN_FIELDS,
  cmpAllowed,
  isBuiltinField,
  isPresenceCmp,
  isValueCmp,
  membershipAllowed,
  type FieldType,
  type ValueCmp,
} from './fields.ts';
import { tokenize } from './lexer.ts';
import type { Token } from './tokens.ts';

export interface ParseOptions {
  /**
   * Custom field catalog (CONTRACTS §C1 shape). `custom.<key>` fields are typed
   * from `entity === 'lead'` entries; an unknown key is a parse error.
   */
  readonly fieldCatalog?: readonly CustomFieldDef[];
}

const MAX_DEPTH = 200;
const UNITS = new Set<string>(RELATIVE_UNITS);
const NAMED = new Set<string>(NAMED_RELDATES);
const ACTIVITIES = new Set<string>(ACTIVITY_TYPES_DSL);

/** Resolved field reference plus its logical type, for type-checking. */
interface ResolvedField {
  readonly ref: FieldRef;
  readonly type: FieldType;
  readonly pos: Position;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;
  private depth = 0;
  private readonly custom: Map<string, FieldType>;

  constructor(tokens: Token[], catalog: readonly CustomFieldDef[]) {
    this.tokens = tokens;
    this.custom = new Map();
    for (const def of catalog) {
      if (def.entity === 'lead') this.custom.set(def.key, def.type);
    }
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const t = this.tokens[this.index] as Token;
    if (t.kind !== 'eof') this.index += 1;
    return t;
  }

  private isKeyword(t: Token, word: string): boolean {
    return t.kind === 'ident' && t.value.toLowerCase() === word;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      throw new ParseError('expression nesting too deep', this.peek().pos);
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  parse(): Ast {
    const expr = this.parseOr();
    const t = this.peek();
    if (t.kind !== 'eof') {
      throw new ParseError(`unexpected trailing input ${describe(t)}`, t.pos);
    }
    return expr;
  }

  private parseOr(): Ast {
    this.enter();
    let left = this.parseAnd();
    while (this.isKeyword(this.peek(), 'or')) {
      this.next();
      const right = this.parseAnd();
      left = { kind: 'or', left, right };
    }
    this.leave();
    return left;
  }

  private parseAnd(): Ast {
    let left = this.parseUnary();
    while (this.isKeyword(this.peek(), 'and')) {
      this.next();
      const right = this.parseUnary();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parseUnary(): Ast {
    this.enter();
    const t = this.peek();
    let result: Ast;
    if (this.isKeyword(t, 'not')) {
      this.next();
      result = { kind: 'not', expr: this.parseUnary() };
    } else if (t.kind === 'lparen') {
      this.next();
      const inner = this.parseOr();
      const close = this.peek();
      if (close.kind !== 'rparen') {
        throw new ParseError(`expected ')' but found ${describe(close)}`, close.pos);
      }
      this.next();
      result = inner;
    } else {
      result = this.parsePredicate();
    }
    this.leave();
    return result;
  }

  private parsePredicate(): Ast {
    const t = this.peek();
    if (t.kind !== 'ident') {
      throw new ParseError(`expected a predicate but found ${describe(t)}`, t.pos);
    }
    const low = t.value.toLowerCase();
    if (low === 'has' || low === 'no') return this.parseActivity();
    if (low === 'matches') return this.parseText();
    return this.parseFieldOrMembership();
  }

  private parseActivity(): Ast {
    const opTok = this.next();
    const op = opTok.value.toLowerCase() as 'has' | 'no';
    const atTok = this.next();
    if (atTok.kind !== 'ident' || !ACTIVITIES.has(atTok.value.toLowerCase())) {
      throw new ParseError(`expected an activity type but found ${describe(atTok)}`, atTok.pos);
    }
    const activity = atTok.value.toLowerCase() as (typeof ACTIVITY_TYPES_DSL)[number];

    let sequenceName: string | undefined;
    if (activity === 'in_sequence') {
      const open = this.next();
      if (open.kind !== 'lparen') {
        throw new ParseError(
          `expected '(' after in_sequence but found ${describe(open)}`,
          open.pos,
        );
      }
      const nameTok = this.next();
      if (nameTok.kind !== 'string') {
        throw new ParseError(
          `in_sequence expects a quoted sequence name but found ${describe(nameTok)}`,
          nameTok.pos,
        );
      }
      sequenceName = nameTok.value;
      const close = this.next();
      if (close.kind !== 'rparen') {
        throw new ParseError(`expected ')' but found ${describe(close)}`, close.pos);
      }
    }

    let within: { n: number; unit: RelativeUnit } | undefined;
    if (this.isKeyword(this.peek(), 'within')) {
      this.next();
      within = this.parseDuration();
    }

    return {
      kind: 'activity',
      op,
      activity,
      ...(sequenceName !== undefined ? { sequenceName } : {}),
      ...(within !== undefined ? { within } : {}),
    };
  }

  private parseDuration(): { n: number; unit: RelativeUnit } {
    const nTok = this.next();
    if (nTok.kind !== 'number') {
      throw new ParseError(`expected a duration amount but found ${describe(nTok)}`, nTok.pos);
    }
    const n = Number(nTok.value);
    if (!Number.isInteger(n) || n < 0) {
      throw new ParseError('duration amount must be a non-negative integer', nTok.pos);
    }
    const uTok = this.next();
    if (uTok.kind !== 'ident' || !UNITS.has(uTok.value.toLowerCase())) {
      throw new ParseError(
        `expected a duration unit (h|d|w|mo) but found ${describe(uTok)}`,
        uTok.pos,
      );
    }
    return { n, unit: uTok.value.toLowerCase() as RelativeUnit };
  }

  private parseText(): Ast {
    this.next(); // 'matches'
    const strTok = this.next();
    if (strTok.kind !== 'string') {
      throw new ParseError(
        `matches expects a quoted string but found ${describe(strTok)}`,
        strTok.pos,
      );
    }
    return { kind: 'text', query: strTok.value };
  }

  private parseFieldOrMembership(): Ast {
    const field = this.parseFieldRef();
    if (this.isKeyword(this.peek(), 'in')) {
      return this.parseMembership(field);
    }
    return this.parseFieldPred(field);
  }

  private parseFieldRef(): ResolvedField {
    const t = this.next();
    const raw = t.value;
    const dot = raw.indexOf('.');
    const firstSeg = (dot === -1 ? raw : raw.slice(0, dot)).toLowerCase();

    if (firstSeg === 'custom' && dot !== -1) {
      const key = raw.slice(dot + 1);
      if (key.length === 0) {
        throw new ParseError('custom field key is empty', t.pos);
      }
      const type = this.custom.get(key);
      if (type === undefined) {
        throw new ParseError(`unknown custom field "custom.${key}"`, t.pos);
      }
      return { ref: { kind: 'custom', key, type }, type, pos: t.pos };
    }

    const nameLower = raw.toLowerCase();
    if (isBuiltinField(nameLower)) {
      return {
        ref: { kind: 'builtin', name: nameLower },
        type: BUILTIN_FIELDS[nameLower],
        pos: t.pos,
      };
    }
    throw new ParseError(`unknown field "${raw}"`, t.pos);
  }

  private parseMembership(field: ResolvedField): Ast {
    this.next(); // 'in'
    if (!membershipAllowed(field.type)) {
      throw new ParseError(
        `field "${fieldLabel(field.ref)}" (type ${field.type}) does not support "in (...)"`,
        field.pos,
      );
    }
    const open = this.next();
    if (open.kind !== 'lparen') {
      throw new ParseError(`expected '(' after "in" but found ${describe(open)}`, open.pos);
    }
    const values: MembershipValue[] = [];
    values.push(this.parseMembershipValue(field));
    while (this.peek().kind === 'comma') {
      this.next();
      values.push(this.parseMembershipValue(field));
    }
    const close = this.next();
    if (close.kind !== 'rparen') {
      throw new ParseError(`expected ')' or ',' but found ${describe(close)}`, close.pos);
    }
    return { kind: 'membership', field: field.ref, values };
  }

  private parseMembershipValue(field: ResolvedField): MembershipValue {
    const t = this.next();
    let value: MembershipValue;
    if (t.kind === 'string') {
      value = { kind: 'string', value: t.value };
    } else if (t.kind === 'number') {
      value = { kind: 'number', value: Number(t.value) };
    } else if (t.kind === 'ident') {
      const low = t.value.toLowerCase();
      if (low === 'me') value = { kind: 'me' };
      else if (low === 'true') value = { kind: 'bool', value: true };
      else if (low === 'false') value = { kind: 'bool', value: false };
      else throw new ParseError(`invalid value in list: ${describe(t)}`, t.pos);
    } else {
      throw new ParseError(`invalid value in list: ${describe(t)}`, t.pos);
    }
    this.checkMembershipValueType(field, value, t.pos);
    return value;
  }

  private checkMembershipValueType(
    field: ResolvedField,
    value: MembershipValue,
    pos: Position,
  ): void {
    const ok = ((): boolean => {
      switch (field.type) {
        case 'user':
          return value.kind === 'string' || value.kind === 'me';
        case 'text':
        case 'select':
          return value.kind === 'string';
        case 'number':
          return value.kind === 'number';
        default:
          return false;
      }
    })();
    if (!ok) {
      throw new ParseError(
        `value of kind "${value.kind}" is not valid for field "${fieldLabel(field.ref)}" (type ${field.type})`,
        pos,
      );
    }
  }

  private parseFieldPred(field: ResolvedField): Ast {
    const cmpTok = this.next();
    let cmp: string;
    if (cmpTok.kind === 'op') {
      cmp = cmpTok.value;
    } else if (cmpTok.kind === 'ident') {
      cmp = cmpTok.value.toLowerCase();
    } else {
      throw new ParseError(`expected a comparator but found ${describe(cmpTok)}`, cmpTok.pos);
    }

    if (isPresenceCmp(cmp)) {
      return { kind: 'presence', field: field.ref, op: cmp };
    }
    if (!isValueCmp(cmp)) {
      throw new ParseError(`expected a comparator but found ${describe(cmpTok)}`, cmpTok.pos);
    }
    if (!cmpAllowed(field.type, cmp)) {
      throw new ParseError(
        `comparator "${cmp}" is not allowed for field "${fieldLabel(field.ref)}" (type ${field.type})`,
        cmpTok.pos,
      );
    }
    const value = this.parseScalarValue();
    this.checkScalarValueType(field, cmp, value);
    return { kind: 'field', field: field.ref, cmp: cmp as ValueCmp, value };
  }

  private parseScalarValue(): ScalarValue {
    const t = this.next();
    switch (t.kind) {
      case 'string':
        return { kind: 'string', value: t.value };
      case 'date':
        return { kind: 'date', value: t.value };
      case 'number': {
        const n = Number(t.value);
        // Relative date? `<number> <unit> ago`
        const u = this.peek();
        if (u.kind === 'ident' && UNITS.has(u.value.toLowerCase())) {
          const after = this.tokens[this.index + 1];
          if (after && after.kind === 'ident' && after.value.toLowerCase() === 'ago') {
            if (!Number.isInteger(n) || n < 0) {
              throw new ParseError('relative date amount must be a non-negative integer', t.pos);
            }
            this.next(); // unit
            this.next(); // ago
            return {
              kind: 'reldate',
              rel: { form: 'relative', n, unit: u.value.toLowerCase() as RelativeUnit },
            };
          }
        }
        return { kind: 'number', value: n };
      }
      case 'ident': {
        const low = t.value.toLowerCase();
        if (low === 'true') return { kind: 'bool', value: true };
        if (low === 'false') return { kind: 'bool', value: false };
        if (NAMED.has(low)) {
          return { kind: 'reldate', rel: { form: 'named', name: low as 'today' } };
        }
        throw new ParseError(`unexpected value ${describe(t)}`, t.pos);
      }
      default:
        throw new ParseError(`expected a value but found ${describe(t)}`, t.pos);
    }
  }

  private checkScalarValueType(field: ResolvedField, cmp: ValueCmp, value: ScalarValue): void {
    const allowed = ((): boolean => {
      switch (field.type) {
        case 'text':
        case 'select':
        case 'user':
          return value.kind === 'string';
        case 'number':
          return value.kind === 'number';
        case 'bool':
          return value.kind === 'bool';
        case 'date':
          return value.kind === 'date' || value.kind === 'reldate';
      }
    })();
    if (!allowed) {
      throw new ParseError(
        `value of kind "${value.kind}" is not valid for field "${fieldLabel(field.ref)}" (type ${field.type}) with comparator "${cmp}"`,
        this.tokens[this.index - 1]?.pos ?? field.pos,
      );
    }
  }
}

function fieldLabel(ref: FieldRef): string {
  return ref.kind === 'builtin' ? ref.name : `custom.${ref.key}`;
}

function describe(t: Token): string {
  if (t.kind === 'eof') return 'end of input';
  if (t.kind === 'string') return `string ${JSON.stringify(t.value)}`;
  return `${t.kind} "${t.text}"`;
}

/**
 * Parse a Smart View DSL string into a typed AST. Throws {@link ParseError} on
 * any lexical, syntactic or type error (all position-carrying).
 */
export function parse(dsl: string, options: ParseOptions = {}): Ast {
  const tokens = tokenize(dsl);
  const parser = new Parser(tokens, options.fieldCatalog ?? []);
  return parser.parse();
}
