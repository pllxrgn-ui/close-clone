import { describe, expect, test } from 'vitest';

import {
  InvalidCursorError,
  decodeCursor,
  decodeCursorTuple,
  encodeCursor,
  type CursorValue,
} from './cursor.ts';

/**
 * Task 4g — keyset cursor codec (CONTRACTS §C7). Round-trips, the opaque wire
 * shape, and every failure path (a malformed cursor is a *client* error →
 * `InvalidCursorError`, never a 500).
 */

describe('encodeCursor / decodeCursor round-trip', () => {
  const cases: CursorValue[][] = [
    [],
    ['00000000-0000-4000-8000-000000000001'],
    ['2026-01-31'],
    ['USD', 2, 'aaaaaaaa-0000-4000-8000-000000000001'],
    [0, -1, 3.5, 'mixed'],
    ['unicode ☕ / slashes', 42],
  ];

  test.each(cases.map((c, i) => [i, c] as const))('case %i round-trips exactly', (_i, tuple) => {
    const encoded = encodeCursor(tuple);
    expect(typeof encoded).toBe('string');
    expect(decodeCursor(encoded)).toEqual(tuple);
  });

  test('the encoding is opaque base64url (no +, /, or = padding)', () => {
    const encoded = encodeCursor(['USD', 2, 'stage-with/slash+and=signs']);
    expect(encoded).not.toMatch(/[+/=]/);
    // base64url is URL-safe: survives a query-string round-trip unescaped.
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });
});

describe('decodeCursor — failure paths (→ InvalidCursorError, C8 VALIDATION_FAILED)', () => {
  test('non-JSON payload throws', () => {
    const raw = Buffer.from('not json at all', 'utf8').toString('base64url');
    expect(() => decodeCursor(raw)).toThrow(InvalidCursorError);
  });

  test('a JSON object (not an array) throws', () => {
    const raw = Buffer.from(JSON.stringify({ a: 1 }), 'utf8').toString('base64url');
    expect(() => decodeCursor(raw)).toThrow(InvalidCursorError);
  });

  test('a bare JSON scalar throws', () => {
    const raw = Buffer.from(JSON.stringify(42), 'utf8').toString('base64url');
    expect(() => decodeCursor(raw)).toThrow(InvalidCursorError);
  });

  test('an array with a non-finite number throws', () => {
    // JSON has no NaN/Infinity literal, so inject via a raw payload.
    const raw = Buffer.from('[1, null]', 'utf8').toString('base64url');
    expect(() => decodeCursor(raw)).toThrow(InvalidCursorError);
  });

  test('an array with a nested object throws', () => {
    const raw = Buffer.from('["ok", {"x":1}]', 'utf8').toString('base64url');
    expect(() => decodeCursor(raw)).toThrow(InvalidCursorError);
  });
});

describe('decodeCursorTuple — arity + per-position typing', () => {
  test('accepts a tuple whose arity and types match the spec', () => {
    const raw = encodeCursor(['USD', 2, 'stage']);
    expect(decodeCursorTuple(raw, ['string', 'number', 'string'])).toEqual(['USD', 2, 'stage']);
  });

  test('rejects an arity mismatch', () => {
    const raw = encodeCursor(['USD', 2]);
    expect(() => decodeCursorTuple(raw, ['string', 'number', 'string'])).toThrow(
      InvalidCursorError,
    );
  });

  test('rejects a per-position type mismatch', () => {
    const raw = encodeCursor(['USD', 'two', 'stage']);
    expect(() => decodeCursorTuple(raw, ['string', 'number', 'string'])).toThrow(
      InvalidCursorError,
    );
  });

  test('a wholly malformed cursor still throws (not a crash)', () => {
    expect(() => decodeCursorTuple('!!! not base64 !!!', ['string'])).toThrow(InvalidCursorError);
  });
});
