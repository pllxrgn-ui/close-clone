/**
 * AST → DSL serializer (CONTRACTS §C3). Normative round-trip:
 * `parse(astToDsl(a)) ≡ a`. Parentheses are inserted only where required to
 * preserve the left-associative precedence (or < and < not < predicate) that the
 * parser reconstructs.
 */
import type { Ast, Expr, FieldRef, MembershipValue, Relative, ScalarValue } from './ast.ts';

const PREC = { or: 1, and: 2, not: 3, leaf: 4 } as const;

interface Emitted {
  readonly text: string;
  readonly prec: number;
}

function wrap(child: Emitted, minPrec: number): string {
  return child.prec >= minPrec ? child.text : `(${child.text})`;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function fieldLabel(ref: FieldRef): string {
  return ref.kind === 'builtin' ? ref.name : `custom.${ref.key}`;
}

function relative(rel: Relative): string {
  return rel.form === 'named' ? rel.name : `${rel.n}${rel.unit} ago`;
}

function scalar(value: ScalarValue): string {
  switch (value.kind) {
    case 'string':
      return quote(value.value);
    case 'number':
      return String(value.value);
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'date':
      return value.value;
    case 'reldate':
      return relative(value.rel);
  }
}

function membershipValue(value: MembershipValue): string {
  switch (value.kind) {
    case 'string':
      return quote(value.value);
    case 'number':
      return String(value.value);
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'me':
      return 'me';
  }
}

function emit(node: Expr): Emitted {
  switch (node.kind) {
    case 'or': {
      const text = `${wrap(emit(node.left), PREC.or)} or ${wrap(emit(node.right), PREC.and)}`;
      return { text, prec: PREC.or };
    }
    case 'and': {
      const text = `${wrap(emit(node.left), PREC.and)} and ${wrap(emit(node.right), PREC.not)}`;
      return { text, prec: PREC.and };
    }
    case 'not':
      return { text: `not ${wrap(emit(node.expr), PREC.not)}`, prec: PREC.not };
    case 'field':
      return {
        text: `${fieldLabel(node.field)} ${node.cmp} ${scalar(node.value)}`,
        prec: PREC.leaf,
      };
    case 'presence':
      return { text: `${fieldLabel(node.field)} ${node.op}`, prec: PREC.leaf };
    case 'membership':
      return {
        text: `${fieldLabel(node.field)} in (${node.values.map(membershipValue).join(', ')})`,
        prec: PREC.leaf,
      };
    case 'activity': {
      const head =
        node.activity === 'in_sequence'
          ? `${node.op} in_sequence(${quote(node.sequenceName ?? '')})`
          : `${node.op} ${node.activity}`;
      const within = node.within ? ` within ${node.within.n}${node.within.unit}` : '';
      return { text: `${head}${within}`, prec: PREC.leaf };
    }
    case 'text':
      return { text: `matches ${quote(node.query)}`, prec: PREC.leaf };
  }
}

/** Serialize a typed AST back to canonical DSL text. */
export function astToDsl(ast: Ast): string {
  return emit(ast).text;
}
