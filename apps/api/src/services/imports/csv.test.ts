import { describe, expect, test } from 'vitest';

import { parseCsvRecords } from './csv.ts';

/**
 * Streaming CSV parser (RFC 4180 + lenient real-world messiness). Every case is
 * also run with the input sliced into 1-byte chunks to prove the state machine
 * survives arbitrary chunk boundaries (BOM, quotes, and CRLF split mid-sequence).
 */

/** Yield `s` (utf8) as `chunkSize`-byte Buffers to stress chunk-boundary handling. */
async function* chunked(s: string, chunkSize: number): AsyncGenerator<Buffer> {
  const buf = Buffer.from(s, 'utf8');
  for (let i = 0; i < buf.length; i += chunkSize) {
    yield buf.subarray(i, i + chunkSize);
  }
}

async function collect(s: string, chunkSize?: number): Promise<string[][]> {
  const out: string[][] = [];
  const input =
    chunkSize === undefined
      ? (async function* () {
          yield s;
        })()
      : chunked(s, chunkSize);
  for await (const rec of parseCsvRecords(input)) out.push(rec);
  return out;
}

/** Run an assertion both whole and byte-sliced. */
async function bothWays(s: string, expected: string[][]): Promise<void> {
  expect(await collect(s)).toEqual(expected);
  expect(await collect(s, 1)).toEqual(expected);
  expect(await collect(s, 3)).toEqual(expected);
}

describe('parseCsvRecords — basics', () => {
  test('simple rows', async () => {
    await bothWays('a,b,c\n1,2,3', [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('trailing newline does not emit a spurious record', async () => {
    await bothWays('a,b\n1,2\n', [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('empty fields are preserved', async () => {
    await bothWays('a,,c', [['a', '', 'c']]);
  });

  test('last line without newline is emitted', async () => {
    await bothWays('h1,h2\nv1,v2', [
      ['h1', 'h2'],
      ['v1', 'v2'],
    ]);
  });

  test('whitespace is not trimmed', async () => {
    await bothWays('  a , b  ', [['  a ', ' b  ']]);
  });
});

describe('parseCsvRecords — line endings', () => {
  test('CRLF', async () => {
    await bothWays('a,b\r\n1,2\r\n', [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('lone CR (old mac)', async () => {
    await bothWays('a,b\r1,2', [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('blank line in the middle becomes an empty record', async () => {
    await bothWays('a\n\nb', [['a'], [''], ['b']]);
  });
});

describe('parseCsvRecords — quoting', () => {
  test('quoted comma', async () => {
    await bothWays('"a,b",c', [['a,b', 'c']]);
  });

  test('quoted newline (record spans lines)', async () => {
    await bothWays('"line1\nline2",c', [['line1\nline2', 'c']]);
  });

  test('quoted CRLF preserved as-is', async () => {
    await bothWays('"x\r\ny",z', [['x\r\ny', 'z']]);
  });

  test('escaped doubled quotes', async () => {
    await bothWays('"she said ""hi""",x', [['she said "hi"', 'x']]);
  });

  test('empty quoted field', async () => {
    await bothWays('"",x', [['', 'x']]);
  });

  test('quoted field followed by delimiter and newline', async () => {
    await bothWays('"a","b"\n"c","d"', [
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('parseCsvRecords — BOM + lenient', () => {
  test('UTF-8 BOM is stripped from the first field only', async () => {
    await bothWays('﻿a,b\nc,d', [
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('a stray quote inside an unquoted field is kept literally', async () => {
    await bothWays('ab"cd,e', [['ab"cd', 'e']]);
  });

  test('multibyte utf8 survives (even sliced across chunks)', async () => {
    await bothWays('café,naïve\nüber,soon', [
      ['café', 'naïve'],
      ['über', 'soon'],
    ]);
  });
});

describe('parseCsvRecords — empty input', () => {
  test('empty string yields no records', async () => {
    expect(await collect('')).toEqual([]);
    expect(await collect('', 1)).toEqual([]);
  });

  test('only a BOM yields no records', async () => {
    expect(await collect('﻿')).toEqual([]);
  });
});
