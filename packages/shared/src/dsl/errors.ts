/**
 * Smart View DSL errors (CONTRACTS §C3).
 *
 * Every failure in the lexer, parser and type-checker is a {@link ParseError}
 * carrying a source {@link Position} (line/col, 1-based) and a human message.
 * The fuzz suite asserts the parser NEVER throws anything else.
 */

export interface Position {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number. */
  readonly col: number;
  /** 0-based byte offset into the source. */
  readonly offset: number;
}

export class ParseError extends Error {
  readonly position: Position;

  constructor(message: string, position: Position) {
    super(`${message} (line ${position.line}, col ${position.col})`);
    this.name = 'ParseError';
    this.position = position;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, ParseError.prototype);
  }
}
