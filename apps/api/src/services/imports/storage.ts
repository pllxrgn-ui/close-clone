import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Raw-CSV storage for the import engine (Task 4f). Under MOCK_MODE this is local
 * disk (CONTRACTS §C1: `file_ref` points at the stored raw CSV — local disk in
 * MOCK_MODE, object storage in deploy). Uploads stream in with a byte cap so a
 * 10k+ row file never sits fully in memory; dry-run and commit read the file
 * back as a stream keyed by the stored `file_ref`.
 *
 * `file_ref` is a base-relative key (not an absolute path) so it stays portable
 * if the storage root moves between environments.
 *
 * Import-safe for direct `node` execution (no enums / namespaces).
 */

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB

export class FileTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`uploaded file exceeds the ${maxBytes}-byte limit`);
    this.name = 'FileTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export interface SaveOptions {
  maxBytes?: number;
}

export interface SaveResult {
  fileRef: string;
  bytes: number;
}

export class ImportStorage {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  /** Storage key for an import's raw CSV. */
  keyFor(importId: string): string {
    return `${importId}.csv`;
  }

  private pathFor(fileRef: string): string {
    // Guard against a key escaping the base dir (path traversal).
    const full = resolve(this.baseDir, fileRef);
    const rel = relative(this.baseDir, full);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`invalid file_ref "${fileRef}"`);
    }
    return full;
  }

  /**
   * Stream `source` to disk under `fileRef`, enforcing `maxBytes`. On overflow or
   * any stream error the partial file is removed and the error re-thrown.
   */
  async save(
    fileRef: string,
    source: AsyncIterable<Buffer>,
    opts: SaveOptions = {},
  ): Promise<SaveResult> {
    const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    await mkdir(this.baseDir, { recursive: true });
    const dest = this.pathFor(fileRef);
    let bytes = 0;
    const meter = async function* (): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > max) throw new FileTooLargeError(max);
        yield chunk;
      }
    };
    const dst = createWriteStream(dest);
    // Attach the close listener before the first await so the event is never
    // missed (pipeline destroys `dst` on error, which fires 'close').
    const closed = new Promise<void>((res) => dst.once('close', () => res()));
    try {
      await pipeline(meter(), dst);
    } catch (err) {
      // Windows: unlinking while the write fd is still open leaves the file in a
      // "delete pending" state that `stat` still sees. Wait for the stream to
      // release the handle, THEN remove — so no partial file survives the throw.
      await closed;
      await rm(dest, { force: true, maxRetries: 3, retryDelay: 25 });
      throw err;
    }
    return { fileRef, bytes };
  }

  /** Open the stored CSV as a byte stream for the parser. */
  open(fileRef: string): Readable {
    return createReadStream(this.pathFor(fileRef));
  }

  async remove(fileRef: string): Promise<void> {
    await rm(this.pathFor(fileRef), { force: true });
  }
}
