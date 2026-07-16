import { describe, expect, test } from 'vitest';

import { csvField, csvHeader, csvRow, jsonlRow, toRecord, type OutputColumn } from './serialize.ts';

/**
 * Task 5g — export serialization. Locks the CSV RFC-4180 quoting rules, the
 * lossless JSON-lines form, and deterministic column ordering (incl. failure /
 * edge inputs: null, embedded quotes/commas/newlines, nested jsonb).
 */

const cols: OutputColumn[] = [
  { key: 'id', get: (r) => r['id'] },
  { key: 'name', get: (r) => r['name'] },
  { key: 'custom', get: (r) => r['custom'] },
  { key: 'custom.tier', get: (r) => (r['custom'] as Record<string, unknown> | null)?.['tier'] },
];

describe('csvField', () => {
  test('null and undefined become the empty field', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  test('plain strings and numbers pass through unquoted', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField(42)).toBe('42');
    expect(csvField(0)).toBe('0');
    expect(csvField(true)).toBe('true');
    expect(csvField(false)).toBe('false');
  });

  test('a comma forces quoting', () => {
    expect(csvField('a,b')).toBe('"a,b"');
  });

  test('an embedded quote is doubled and the field quoted', () => {
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""');
  });

  test('newlines and carriage returns force quoting', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('a\r\nb')).toBe('"a\r\nb"');
  });

  test('objects and arrays are JSON-encoded (then quoted for embedded quotes/commas)', () => {
    // The JSON text contains double quotes, so the field is always quoted+escaped.
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvField([1, 2])).toBe('"[1,2]"');
    expect(csvField({ a: 1, b: 2 })).toBe('"{""a"":1,""b"":2}"');
  });

  test('bigint is stringified', () => {
    expect(csvField(9007199254740993n)).toBe('9007199254740993');
  });
});

describe('csvHeader / csvRow', () => {
  const row = { id: 'L1', name: 'Ann, Inc', custom: { tier: 'gold', size: 3 } };

  test('header is the column keys in order, LF-terminated', () => {
    expect(csvHeader(cols)).toBe('id,name,custom,custom.tier\n');
  });

  test('row encodes cells in column order with flattening', () => {
    // name has a comma → quoted; custom is JSON (quoted for its comma); flattened tier.
    expect(csvRow(row, cols)).toBe('L1,"Ann, Inc","{""tier"":""gold"",""size"":3}",gold\n');
  });

  test('a missing flattened key yields an empty cell, not a crash', () => {
    const bare = { id: 'L2', name: 'X', custom: null };
    expect(csvRow(bare, cols)).toBe('L2,X,,\n');
  });
});

describe('toRecord / jsonlRow (lossless)', () => {
  const row = { id: 'L1', name: 'Ann', custom: { tier: 'gold', size: 3 } };

  test('toRecord preserves column order and keeps objects intact', () => {
    const rec = toRecord(row, cols);
    expect(Object.keys(rec)).toEqual(['id', 'name', 'custom', 'custom.tier']);
    expect(rec['custom']).toEqual({ tier: 'gold', size: 3 });
    expect(rec['custom.tier']).toBe('gold');
  });

  test('undefined normalizes to null so the key is always present', () => {
    const rec = toRecord({ id: 'L3' }, cols);
    expect(rec['name']).toBeNull();
    expect(rec['custom']).toBeNull();
    expect(rec['custom.tier']).toBeNull();
  });

  test('jsonlRow round-trips exactly through JSON.parse', () => {
    const line = jsonlRow(row, cols);
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      id: 'L1',
      name: 'Ann',
      custom: { tier: 'gold', size: 3 },
      'custom.tier': 'gold',
    });
  });
});
