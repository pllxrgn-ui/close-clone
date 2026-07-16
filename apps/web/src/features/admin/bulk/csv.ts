/*
 * Client-side CSV export for the bulk bar's "Export CSV" action. Pure builder
 * (`leadsToCsv`) + a browser download helper (`downloadCsv`), kept apart so the
 * serialization is unit-testable without a DOM. RFC 4180: fields containing a
 * comma, quote, or newline are wrapped in double quotes with `"` doubled; rows
 * end in CRLF.
 */
import type { Lead } from '@switchboard/shared';

export interface CsvLabelCtx {
  ownerName: (ownerId: string | null) => string;
  statusLabel: (statusId: string | null) => string;
}

const CSV_HEADERS = ['Name', 'Status', 'Owner', 'DNC', 'Last contacted', 'Created', 'URL'] as const;

function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Serialize a header row + string cells into an RFC 4180 CSV document. */
export function toCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [headers, ...rows].map((cells) => cells.map(escapeField).join(','));
  return lines.join('\r\n');
}

const dateOnly = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');

/** Build the export CSV for a set of selected leads, resolving id → label. */
export function leadsToCsv(leads: readonly Lead[], ctx: CsvLabelCtx): string {
  const rows = leads.map((lead) => [
    lead.name,
    ctx.statusLabel(lead.statusId),
    ctx.ownerName(lead.ownerId),
    lead.dnc ? 'Yes' : 'No',
    dateOnly(lead.lastContactedAt),
    dateOnly(lead.createdAt),
    lead.url ?? '',
  ]);
  return toCsv(CSV_HEADERS, rows);
}

/** A timestamped, filesystem-safe export filename (e.g. `leads-2026-07-16.csv`). */
export function csvFilename(now: Date = new Date()): string {
  return `leads-${now.toISOString().slice(0, 10)}.csv`;
}

/**
 * Trigger a real browser download of `content` as `filename`. No-ops safely if
 * the environment lacks URL.createObjectURL (jsdom without the polyfill). Returns
 * whether a download was actually initiated.
 */
export function downloadCsv(filename: string, content: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return false;
  }
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}
