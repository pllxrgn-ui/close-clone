/**
 * Minimal streaming `multipart/form-data` extractor (Task 4f). Pulls the FIRST
 * file part (a part carrying a `filename`) out of a raw request byte stream and
 * exposes its body as an async generator, so a 10k+ row upload is written to
 * storage without ever being materialised in memory.
 *
 * Scope is deliberately narrow — the `POST /imports` upload is a single CSV file
 * from a controlled internal client (CONTRACTS §C7) — so this is not a general
 * RFC 7578 parser: it handles a preamble, leading non-file fields (skipped),
 * quoted `Content-Disposition` params, and CRLF-delimited parts. `@fastify/
 * multipart` would cover the long tail, but was avoided to keep the module
 * dependency-free and provably streaming (see the byte-sliced tests).
 *
 * Import-safe for direct `node` execution (no enums / namespaces).
 */

const CRLF = Buffer.from('\r\n');
const CRLF_CRLF = Buffer.from('\r\n\r\n');
const DASH_DASH = Buffer.from('--');

export class MultipartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultipartError';
  }
}

export interface ExtractedFile {
  /** The part's `filename` param (may be empty string), or null if unnamed. */
  filename: string | null;
  /** The part's form field `name`, or null. */
  fieldName: string | null;
  /** Streams the file part's body bytes (bounded look-back, never buffers all). */
  body: AsyncGenerator<Buffer>;
}

/** Parse the `boundary` token out of a `multipart/form-data` Content-Type. */
export function parseBoundary(contentType: string | undefined): string | null {
  if (contentType === undefined) return null;
  if (!/^\s*multipart\/form-data/i.test(contentType)) return null;
  const m = /;\s*boundary=("?)([^";]+)\1/i.exec(contentType);
  return m ? (m[2] ?? null) : null;
}

interface Disposition {
  filename: string | null;
  fieldName: string | null;
}

/** Parse `Content-Disposition` name/filename from a part's raw header block. */
function parseDisposition(headerBlock: string): Disposition {
  let filename: string | null = null;
  let fieldName: string | null = null;
  for (const line of headerBlock.split('\r\n')) {
    if (!/^content-disposition:/i.test(line)) continue;
    const nameM = /;\s*name="([^"]*)"/i.exec(line);
    if (nameM) fieldName = nameM[1] ?? null;
    const fileM = /;\s*filename="([^"]*)"/i.exec(line);
    if (fileM) filename = fileM[1] ?? null;
  }
  return { filename, fieldName };
}

/**
 * Buffered pull-reader over a raw byte stream. `readUntil` buffers up to a small
 * needle (part headers); `streamUntil` yields the body with a bounded look-back
 * so a delimiter split across chunk boundaries is still detected.
 */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  private readonly iter: AsyncIterator<Buffer>;

  constructor(source: AsyncIterable<Buffer>) {
    this.iter = source[Symbol.asyncIterator]();
  }

  private async pull(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.iter.next();
    if (next.done === true) {
      this.ended = true;
      return false;
    }
    const chunk = next.value;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    return true;
  }

  /** Consume through `needle`, returning the bytes before it; null at EOF. */
  async readUntil(needle: Buffer): Promise<Buffer | null> {
    for (;;) {
      const idx = this.buf.indexOf(needle);
      if (idx !== -1) {
        const before = this.buf.subarray(0, idx);
        this.buf = this.buf.subarray(idx + needle.length);
        return before;
      }
      if (!(await this.pull())) return null;
    }
  }

  /** Yield bytes up to `needle` (exclusive), consuming through it. Throws at EOF. */
  async *streamUntil(needle: Buffer): AsyncGenerator<Buffer> {
    const keep = needle.length - 1;
    for (;;) {
      const idx = this.buf.indexOf(needle);
      if (idx !== -1) {
        if (idx > 0) yield this.buf.subarray(0, idx);
        this.buf = this.buf.subarray(idx + needle.length);
        return;
      }
      const safe = this.buf.length - keep;
      if (safe > 0) {
        yield this.buf.subarray(0, safe);
        this.buf = this.buf.subarray(safe);
      }
      if (!(await this.pull())) throw new MultipartError('unterminated multipart file part');
    }
  }

  /** Consume (discard) through `needle`. Throws at EOF. */
  async skipUntil(needle: Buffer): Promise<void> {
    for await (const _chunk of this.streamUntil(needle)) {
      // discard
    }
  }
}

/**
 * Read the first file part from `source`. Resolves once the part's headers are
 * parsed (filename known); the returned `body` generator must be fully drained
 * to advance/complete the stream. Throws `MultipartError` on a malformed body or
 * when no file part is present.
 */
export async function readFirstFilePart(
  source: AsyncIterable<Buffer>,
  boundary: string,
): Promise<ExtractedFile> {
  const reader = new ByteReader(source);
  const opening = Buffer.from(`--${boundary}`);
  const bodyDelimiter = Buffer.from(`\r\n--${boundary}`);

  // Discard the preamble and consume the opening boundary.
  if ((await reader.readUntil(opening)) === null) {
    throw new MultipartError('multipart opening boundary not found');
  }

  for (;;) {
    // After a boundary: `--` (final boundary) or CRLF then a part.
    const marker = await reader.readUntil(CRLF);
    if (marker === null) throw new MultipartError('truncated multipart stream');
    if (marker.length >= 2 && marker.subarray(0, 2).equals(DASH_DASH)) {
      throw new MultipartError('multipart contained no file part');
    }

    const headerBlock = await reader.readUntil(CRLF_CRLF);
    if (headerBlock === null) throw new MultipartError('truncated multipart part headers');
    const { filename, fieldName } = parseDisposition(headerBlock.toString('latin1'));

    if (filename !== null) {
      return { filename, fieldName, body: reader.streamUntil(bodyDelimiter) };
    }

    // A non-file field: skip its body to the next boundary and keep looking.
    await reader.skipUntil(bodyDelimiter);
  }
}
