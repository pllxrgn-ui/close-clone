import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { FileTooLargeError, ImportStorage } from './storage.ts';

/** Local-disk raw-CSV storage: streaming save/open round-trip + size cap. */

let baseDir: string;
let storage: ImportStorage;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'sb-import-store-'));
  storage = new ImportStorage(baseDir);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

async function* chunks(parts: string[]): AsyncGenerator<Buffer> {
  for (const p of parts) yield Buffer.from(p, 'utf8');
}

describe('ImportStorage', () => {
  test('saves a streamed file and reads it back byte-identical', async () => {
    const ref = storage.keyFor('11111111-2222-3333-4444-555555555555');
    const res = await storage.save(ref, chunks(['name,url\n', 'Acme,acme.com\n']));
    expect(res.fileRef).toBe(ref);
    expect(res.bytes).toBe(Buffer.byteLength('name,url\nAcme,acme.com\n'));

    const read: Buffer[] = [];
    for await (const c of storage.open(ref)) read.push(c as Buffer);
    expect(Buffer.concat(read).toString()).toBe('name,url\nAcme,acme.com\n');
  });

  test('enforces the byte cap and leaves no partial file behind', async () => {
    const ref = storage.keyFor('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    await expect(
      storage.save(ref, chunks(['0123456789', '0123456789']), { maxBytes: 15 }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(stat(join(baseDir, ref))).rejects.toThrow(); // removed
  });

  test('remove deletes the stored file', async () => {
    const ref = storage.keyFor('99999999-8888-7777-6666-555555555555');
    await storage.save(ref, chunks(['x']));
    await storage.remove(ref);
    await expect(stat(join(baseDir, ref))).rejects.toThrow();
  });

  test('rejects a traversing file_ref', () => {
    expect(() => storage.open('../escape.csv')).toThrow('invalid file_ref');
  });

  test('written file lands under the base dir', async () => {
    const ref = storage.keyFor('12121212-3434-5656-7878-909090909090');
    await storage.save(ref, chunks(['hello']));
    expect((await readFile(join(baseDir, ref))).toString()).toBe('hello');
  });
});
