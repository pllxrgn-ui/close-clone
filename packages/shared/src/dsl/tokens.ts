/** Token model for the Smart View DSL lexer (CONTRACTS §C3). */
import type { Position } from './errors.ts';

export type TokenKind =
  | 'string' // double-quoted literal (value is the decoded content)
  | 'number' // integer or decimal
  | 'date' // ISO-8601 date/datetime
  | 'ident' // identifier / keyword / dotted path (e.g. custom.foo)
  | 'op' // comparison operator: = != < <= > >=
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** Raw source slice (for diagnostics). */
  readonly text: string;
  /** Processed value: decoded string for `string`, raw text otherwise. */
  readonly value: string;
  readonly pos: Position;
}
