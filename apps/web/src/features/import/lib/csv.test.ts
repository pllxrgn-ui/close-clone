import { describe, expect, test } from 'vitest';
import { CsvParseError, parseCsv, parseCsvRecords, sampleCsv } from './csv.ts';

describe('parseCsvRecords', () => {
  test('splits a simple grid into records', () => {
    expect(parseCsvRecords('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('honors quoted fields containing a comma', () => {
    expect(parseCsvRecords('name,note\n"Acme, Inc",hello')).toEqual([
      ['name', 'note'],
      ['Acme, Inc', 'hello'],
    ]);
  });

  test('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsvRecords('"He said ""hi"""')).toEqual([['He said "hi"']]);
  });

  test('keeps newlines that live inside a quoted field', () => {
    expect(parseCsvRecords('"line1\nline2",b')).toEqual([['line1\nline2', 'b']]);
  });

  test('treats CRLF as a record separator', () => {
    expect(parseCsvRecords('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('ignores a trailing newline (no phantom empty record)', () => {
    expect(parseCsvRecords('a\n1\n')).toEqual([['a'], ['1']]);
  });

  test('preserves a genuinely blank line as an empty-cell record', () => {
    // A blank data line is a real (empty) row the planner counts as "empty".
    expect(parseCsvRecords('a,b\n\n1,2')).toEqual([['a', 'b'], [''], ['1', '2']]);
  });

  test('returns no records for empty text', () => {
    expect(parseCsvRecords('')).toEqual([]);
  });

  test('throws CsvParseError on an unterminated quoted field', () => {
    expect(() => parseCsvRecords('"never closed')).toThrow(CsvParseError);
  });
});

describe('parseCsv', () => {
  test('separates the header record from data rows', () => {
    expect(parseCsv('Company,Email\nNorth Labs,a@b.com')).toEqual({
      headers: ['Company', 'Email'],
      rows: [['North Labs', 'a@b.com']],
    });
  });

  test('yields empty header + rows for empty text', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });

  test('trims a UTF-8 BOM off the first header cell', () => {
    const { headers } = parseCsv('﻿Company,Email\nx,y');
    expect(headers).toEqual(['Company', 'Email']);
  });
});

describe('sampleCsv', () => {
  test('is a parseable document with the expected header columns', () => {
    const { headers, rows } = parseCsv(sampleCsv());
    expect(headers).toContain('Company');
    expect(headers).toContain('Email');
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  test('contains an in-file duplicate company (a dedupe demonstration)', () => {
    const { headers, rows } = parseCsv(sampleCsv());
    const companyIdx = headers.indexOf('Company');
    const names = rows.map((r) => r[companyIdx]).filter((n): n is string => Boolean(n));
    const seen = new Set<string>();
    const hasDupe = names.some((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(hasDupe).toBe(true);
  });

  test('contains a malformed-email row (an error demonstration)', () => {
    expect(sampleCsv()).toMatch(/not-an-email/);
  });
});
