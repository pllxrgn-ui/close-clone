/**
 * Keyset pagination cursor codec for the reporting read layer (Task 4g,
 * CONTRACTS §C7). Each report orders its rows by a small, totally-ordered key
 * tuple (a rep id, a UTC date, a stage/currency tuple, a sequence id) and
 * encodes that tuple as an opaque base64url cursor. The codec is deliberately
 * generic — it moves a tuple of scalars across the wire — and each report module
 * supplies its own typed encode/decode wrapper over it (validating arity + the
 * per-position types), so a cursor minted for one report can never be silently
 * misread by another.
 *
 * A malformed cursor is a *client* error: `decodeCursor` throws
 * `InvalidCursorError`, which the route maps to `VALIDATION_FAILED` (§C8), never
 * a 500. No user value is ever string-spliced into SQL — decoded cursor values
 * are bound as parameters by the callers (§C3).
 */

/** A scalar keyset component. Reports key on rep ids, dates, stage ids, ints. */
export type CursorValue = string | number;

/** Thrown when a supplied pagination cursor is malformed. Maps to 400 (§C8). */
export class InvalidCursorError extends Error {
  constructor(message = 'invalid report cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/** Encode a keyset tuple as an opaque base64url cursor. */
export function encodeCursor(values: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor back to its scalar tuple. Base64url decoding in Node is
 * lenient (it never throws), so every real guard lives here: the payload must be
 * a JSON array of finite numbers / strings. Anything else → `InvalidCursorError`.
 */
export function decodeCursor(raw: string): CursorValue[] {
  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidCursorError();
  }

  if (!Array.isArray(parsed)) throw new InvalidCursorError();
  for (const v of parsed) {
    const t = typeof v;
    if (t === 'string') continue;
    if (t === 'number' && Number.isFinite(v)) continue;
    throw new InvalidCursorError();
  }
  return parsed as CursorValue[];
}

/**
 * Decode a cursor and assert its shape position-by-position. `spec` is the
 * expected type of each component; a mismatch in arity or type throws
 * `InvalidCursorError`. Returns the validated tuple (still typed as the generic
 * union — callers destructure with known positions).
 */
export function decodeCursorTuple(
  raw: string,
  spec: readonly ('string' | 'number')[],
): CursorValue[] {
  const values = decodeCursor(raw);
  if (values.length !== spec.length) throw new InvalidCursorError();
  for (let i = 0; i < spec.length; i += 1) {
    if (typeof values[i] !== spec[i]) throw new InvalidCursorError();
  }
  return values;
}
