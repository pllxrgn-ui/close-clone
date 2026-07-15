import { describe, expect, test } from 'vitest';

import { MultipartError, parseBoundary, readFirstFilePart } from './multipart.ts';

/**
 * Streaming multipart file extractor. Bodies are assembled with explicit CRLFs
 * and every case is also fed in 1- and 7-byte slices to prove the delimiter
 * search survives arbitrary chunk boundaries (like the CSV parser's tests).
 */

const B = 'X-BOUNDARY-123';

/** Build a multipart/form-data body from ordered parts (fields + one file). */
function buildBody(
  parts: { name: string; filename?: string; value: string | Buffer }[],
  opts: { preamble?: string; boundary?: string } = {},
): Buffer {
  const boundary = opts.boundary ?? B;
  const chunks: Buffer[] = [];
  if (opts.preamble !== undefined) chunks.push(Buffer.from(opts.preamble));
  for (const p of parts) {
    const disp =
      p.filename !== undefined
        ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"`
        : `Content-Disposition: form-data; name="${p.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disp}\r\n\r\n`));
    chunks.push(typeof p.value === 'string' ? Buffer.from(p.value) : p.value);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function* sliced(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

async function extractFile(
  buf: Buffer,
  boundary: string,
  chunkSize?: number,
): Promise<{ filename: string | null; fieldName: string | null; body: Buffer }> {
  const source =
    chunkSize === undefined
      ? (async function* () {
          yield buf;
        })()
      : sliced(buf, chunkSize);
  const file = await readFirstFilePart(source, boundary);
  const out: Buffer[] = [];
  for await (const c of file.body) out.push(c);
  return { filename: file.filename, fieldName: file.fieldName, body: Buffer.concat(out) };
}

/** Assert extraction is identical whole and byte-sliced. */
async function bothWays(buf: Buffer, expected: string, boundary = B): Promise<void> {
  for (const chunk of [undefined, 1, 7]) {
    const r = await extractFile(buf, boundary, chunk);
    expect(r.body.toString('utf8')).toBe(expected);
  }
}

describe('parseBoundary', () => {
  test('extracts the boundary token', () => {
    expect(parseBoundary('multipart/form-data; boundary=----abc123')).toBe('----abc123');
    expect(parseBoundary('multipart/form-data; boundary="quoted-b"')).toBe('quoted-b');
    expect(parseBoundary('multipart/form-data; charset=utf-8; boundary=b2')).toBe('b2');
  });

  test('rejects non-multipart and missing boundary', () => {
    expect(parseBoundary('application/json')).toBeNull();
    expect(parseBoundary('multipart/form-data')).toBeNull();
    expect(parseBoundary(undefined)).toBeNull();
  });
});

describe('readFirstFilePart — extraction', () => {
  test('single file part', async () => {
    const body = buildBody([{ name: 'file', filename: 'leads.csv', value: 'a,b\n1,2\n' }]);
    const r = await extractFile(body, B);
    expect(r.filename).toBe('leads.csv');
    expect(r.fieldName).toBe('file');
    expect(r.body.toString()).toBe('a,b\n1,2\n');
  });

  test('CSV body with quoted commas + embedded CRLF survives', async () => {
    const csv = 'name,note\r\n"Acme, Inc.","line1\r\nline2"\r\n';
    const body = buildBody([{ name: 'file', filename: 'x.csv', value: csv }]);
    await bothWays(body, csv);
  });

  test('a preamble before the first boundary is discarded', async () => {
    const body = buildBody([{ name: 'file', filename: 'x.csv', value: 'hello' }], {
      preamble: 'this is ignored preamble text\r\n',
    });
    await bothWays(body, 'hello');
  });

  test('leading non-file fields are skipped; the file part is returned', async () => {
    const body = buildBody([
      { name: 'mapping', value: '{"columns":[]}' },
      { name: 'file', filename: 'data.csv', value: 'col\nval' },
    ]);
    const r = await extractFile(body, B, 3);
    expect(r.filename).toBe('data.csv');
    expect(r.body.toString()).toBe('col\nval');
  });

  test('empty file body', async () => {
    const body = buildBody([{ name: 'file', filename: 'empty.csv', value: '' }]);
    await bothWays(body, '');
  });

  test('binary-ish content with bytes resembling the boundary prefix', async () => {
    // Contains "--" and partial boundary-looking text that is NOT the delimiter.
    const tricky = 'a--X-BOUNDARY-12,b\n--not-the-boundary\n';
    const body = buildBody([{ name: 'file', filename: 'x.csv', value: tricky }]);
    await bothWays(body, tricky);
  });

  test('a leading UTF-8 BOM in the file body is preserved (parser strips it later)', async () => {
    const withBom = '﻿name\n1';
    const body = buildBody([{ name: 'file', filename: 'x.csv', value: withBom }]);
    await bothWays(body, withBom);
  });
});

describe('readFirstFilePart — failure paths', () => {
  test('no file part → MultipartError', async () => {
    const body = buildBody([{ name: 'notafile', value: 'just a field' }]);
    await expect(extractFile(body, B)).rejects.toBeInstanceOf(MultipartError);
  });

  test('missing opening boundary → MultipartError', async () => {
    const source = (async function* () {
      yield Buffer.from('no boundary here at all');
    })();
    await expect(readFirstFilePart(source, B)).rejects.toBeInstanceOf(MultipartError);
  });

  test('truncated after headers (no closing boundary) → MultipartError', async () => {
    const truncated = Buffer.from(
      `--${B}\r\nContent-Disposition: form-data; name="file"; filename="x.csv"\r\n\r\nabc`,
    );
    const source = (async function* () {
      yield truncated;
    })();
    const file = await readFirstFilePart(source, B);
    const drain = async (): Promise<void> => {
      for await (const _c of file.body) {
        // consume until it throws
      }
    };
    await expect(drain()).rejects.toBeInstanceOf(MultipartError);
  });
});
