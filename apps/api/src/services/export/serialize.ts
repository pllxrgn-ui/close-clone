/**
 * Serialization primitives for the full-data export (Task 5g). Two on-disk
 * formats share one ordered-column model:
 *
 *   - JSON-lines (`.jsonl`): one `JSON.stringify(record)` per line. Lossless —
 *     objects stay objects, `null` stays `null` — so it is the authoritative
 *     round-trippable form (CONTRACTS §5g acceptance: re-checking counts/rows
 *     matches the DB exactly).
 *   - CSV (`.csv`): a header row of column keys followed by one encoded row per
 *     record. Spreadsheet-friendly; jsonb/array cells are JSON-encoded strings and
 *     `null` flattens to empty (CSV cannot distinguish null from empty string —
 *     JSON-lines is the format that guarantees fidelity).
 *
 * Column order is caller-supplied and stable, so both formats are byte-
 * deterministic for a given row set. Import-safe for direct `node` execution
 * (no enums / namespaces / parameter properties — the host type-stripping
 * constraint).
 */

/** One output column: a stable key and how to pull its value from a DB row. */
export interface OutputColumn {
  /** Emitted name (snake_case DB column, or `custom.<key>` for a flattened field). */
  key: string;
  /** Extract this column's value from a raw DB row (keyed by Drizzle JS prop). */
  get: (row: Record<string, unknown>) => unknown;
}

const LINE = '\n';

/**
 * Encode one value as a single CSV field. Quoting follows RFC 4180: a field is
 * wrapped in double quotes when it contains a comma, quote, CR, or LF, and any
 * embedded quote is doubled. Objects/arrays are JSON-encoded first; `null`/
 * `undefined` become the empty field.
 */
export function csvField(value: unknown): string {
  const raw = csvStringify(value);
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function csvStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    case 'object':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/** Join already-raw values into one CSV line (encodes each), LF-terminated. */
export function csvLine(values: readonly unknown[]): string {
  return values.map(csvField).join(',') + LINE;
}

/** The CSV header line for a column set. */
export function csvHeader(columns: readonly OutputColumn[]): string {
  return csvLine(columns.map((c) => c.key));
}

/** The CSV data line for a row under a column set. */
export function csvRow(row: Record<string, unknown>, columns: readonly OutputColumn[]): string {
  return csvLine(columns.map((c) => c.get(row)));
}

/**
 * Build an ordered plain object for a row under a column set — key order follows
 * `columns`, so `JSON.stringify` is deterministic. `undefined` values are
 * normalized to `null` so a missing column is explicit (and survives JSON).
 */
export function toRecord(
  row: Record<string, unknown>,
  columns: readonly OutputColumn[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    const v = c.get(row);
    out[c.key] = v === undefined ? null : v;
  }
  return out;
}

/** The JSON-lines representation of a row under a column set, LF-terminated. */
export function jsonlRow(row: Record<string, unknown>, columns: readonly OutputColumn[]): string {
  return JSON.stringify(toRecord(row, columns)) + LINE;
}
