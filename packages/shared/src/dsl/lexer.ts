/**
 * Hand-written lexer for the Smart View DSL (CONTRACTS §C3).
 *
 * Produces a flat token stream with 1-based line/col positions. Keyword handling
 * is deferred to the parser: keywords are lexed as `ident` and interpreted
 * case-insensitively in context, so `status`, `and`, `has`, `is_set` are all
 * plain identifiers at this layer.
 */
import { ParseError, type Position } from './errors.ts';
import type { Token, TokenKind } from './tokens.ts';

// ISO-8601 date, optionally with time and zone. Anchored; matched before number
// so that `2024-01-15` is one token rather than `2024 - 01 - 15`.
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/;
const NUMBER = /^-?\d+(?:\.\d+)?/;
// Dotted identifier: segments of [A-Za-z_][A-Za-z0-9_]* joined by dots.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const posHere = (): Position => ({ line, col, offset: i });

  const advance = (n: number): void => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };

  const push = (kind: TokenKind, text: string, value: string, at: Position): void => {
    tokens.push({ kind, text, value, pos: at });
  };

  while (i < src.length) {
    const ch = src[i] as string;

    // Whitespace.
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance(1);
      continue;
    }

    const start = posHere();

    // String literal.
    if (ch === '"') {
      const decoded = readString(src, i, start, advance);
      push('string', decoded.raw, decoded.value, start);
      continue;
    }

    // Comparison operators.
    if (ch === '!' || ch === '<' || ch === '>' || ch === '=') {
      const two = src.slice(i, i + 2);
      if (two === '!=' || two === '<=' || two === '>=') {
        advance(2);
        push('op', two, two, start);
        continue;
      }
      if (ch === '=' || ch === '<' || ch === '>') {
        advance(1);
        push('op', ch, ch, start);
        continue;
      }
      // Lone '!' is not a valid token.
      throw new ParseError(`unexpected character '!'`, start);
    }

    // Parentheses / comma.
    if (ch === '(') {
      advance(1);
      push('lparen', ch, ch, start);
      continue;
    }
    if (ch === ')') {
      advance(1);
      push('rparen', ch, ch, start);
      continue;
    }
    if (ch === ',') {
      advance(1);
      push('comma', ch, ch, start);
      continue;
    }

    const rest = src.slice(i);

    // Date (before number: dates begin with digits).
    const dm = ISO_DATE.exec(rest);
    if (dm && /^\d/.test(ch)) {
      const text = dm[0];
      advance(text.length);
      push('date', text, text, start);
      continue;
    }

    // Number (including negative).
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const nm = NUMBER.exec(rest);
      // NUMBER always matches here given the guard above.
      const text = (nm as RegExpExecArray)[0];
      advance(text.length);
      push('number', text, text, start);
      continue;
    }

    // Identifier / keyword / dotted path.
    const im = IDENT.exec(rest);
    if (im) {
      const text = im[0];
      advance(text.length);
      push('ident', text, text, start);
      continue;
    }

    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`, start);
  }

  tokens.push({ kind: 'eof', text: '', value: '', pos: posHere() });
  return tokens;
}

function readString(
  src: string,
  startIndex: number,
  start: Position,
  advance: (n: number) => void,
): { raw: string; value: string } {
  // Consume opening quote.
  advance(1);
  let j = startIndex + 1;
  let value = '';
  while (j < src.length) {
    const c = src[j] as string;
    if (c === '\\') {
      const next = src[j + 1];
      if (next === '"') {
        value += '"';
        advance(2);
        j += 2;
        continue;
      }
      if (next === '\\') {
        value += '\\';
        advance(2);
        j += 2;
        continue;
      }
      // Unknown escape: keep the backslash literally.
      value += '\\';
      advance(1);
      j += 1;
      continue;
    }
    if (c === '"') {
      advance(1);
      j += 1;
      const raw = src.slice(startIndex, j);
      return { raw, value };
    }
    value += c;
    advance(1);
    j += 1;
  }
  throw new ParseError('unterminated string literal', start);
}
