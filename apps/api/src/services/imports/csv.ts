import { StringDecoder } from 'node:string_decoder';

/**
 * Streaming CSV parser (Task 4f). RFC 4180 quoting with real-world leniency,
 * driven off an async byte/text stream so a 10k+ row file is never materialised
 * in memory — records are yielded one at a time as the bytes arrive.
 *
 * Handled: quoted fields containing commas / newlines / CRLF, doubled-quote
 * escapes (`""`), mixed CRLF / LF / lone-CR line endings, a leading UTF-8 BOM,
 * empty fields and blank lines, and multibyte UTF-8 split across chunk
 * boundaries (via `StringDecoder`). A stray quote inside an unquoted field is
 * kept literally rather than throwing — messy exports should surface as
 * row-level mapping errors downstream, not as a hard parse failure.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties), consistent with the rest of the services layer.
 */

/** A single logical CSV record: the raw field strings, untrimmed. */
export type CsvRecord = string[];

/** True when every field is empty or whitespace (a blank / throwaway row). */
export function isBlankRecord(record: CsvRecord): boolean {
  return record.every((f) => f.trim() === '');
}

export async function* parseCsvRecords(
  input: AsyncIterable<Buffer | string>,
): AsyncGenerator<CsvRecord> {
  const decoder = new StringDecoder('utf8');

  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let quoteClosed = false; // just consumed the closing `"` of a quoted section
  let fieldStart = true; // at the first char of a field → a `"` opens quoting
  let prevCR = false; // last terminator was CR → swallow a following LF
  let dirty = false; // current record has any pending content (for EOF flush)
  let bomPending = true;

  // Buffer of complete records produced while scanning one chunk, then yielded.
  let out: CsvRecord[] = [];

  const endField = (): void => {
    record.push(field);
    field = '';
    fieldStart = true;
    quoteClosed = false;
  };
  const endRecord = (): void => {
    endField();
    out.push(record);
    record = [];
    dirty = false;
  };

  const feed = (s: string): void => {
    for (const c of s) {
      if (inQuotes) {
        if (c === '"') {
          inQuotes = false;
          quoteClosed = true;
        } else {
          field += c;
        }
        dirty = true;
        prevCR = false;
        continue;
      }
      if (quoteClosed) {
        quoteClosed = false;
        if (c === '"') {
          // Doubled quote inside a quoted field → one literal quote, reopen.
          field += '"';
          inQuotes = true;
          dirty = true;
          prevCR = false;
          continue;
        }
        // otherwise fall through and handle `c` as an ordinary post-quote char
      }
      if (c === '"' && fieldStart) {
        inQuotes = true;
        fieldStart = false;
        dirty = true;
        prevCR = false;
        continue;
      }
      if (c === ',') {
        endField();
        dirty = true;
        prevCR = false;
        continue;
      }
      if (c === '\r') {
        endRecord();
        prevCR = true;
        continue;
      }
      if (c === '\n') {
        if (prevCR) {
          prevCR = false;
          continue;
        }
        endRecord();
        continue;
      }
      field += c;
      fieldStart = false;
      dirty = true;
      prevCR = false;
    }
  };

  for await (const chunk of input) {
    let s = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (bomPending && s.length > 0) {
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      bomPending = false;
    }
    if (s.length > 0) feed(s);
    if (out.length > 0) {
      const batch = out;
      out = [];
      yield* batch;
    }
  }

  const tail = decoder.end();
  if (bomPending && tail.length > 0 && tail.charCodeAt(0) === 0xfeff) {
    feed(tail.slice(1));
  } else if (tail.length > 0) {
    feed(tail);
  }
  for (const rec of out) yield rec;

  // Flush a final record that had no trailing terminator.
  if (dirty || field !== '' || record.length > 0 || inQuotes || quoteClosed) {
    record.push(field);
    yield record;
  }
}
