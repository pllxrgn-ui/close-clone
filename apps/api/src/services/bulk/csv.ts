import type { RawLeadRow } from '../smartviews/index.ts';

/**
 * Server-side export serializers for the bulk `export` action (Task R3). The web
 * bulk bar exports CSV client-side; this is the API-side equivalent over a whole
 * smart-view target set (which the client, holding only the loaded page, cannot
 * produce). Emits the C7 Lead DTO fields — no label joins, deterministic order.
 */

const CSV_COLUMNS: { header: string; get: (l: RawLeadRow) => string | null }[] = [
  { header: 'id', get: (l) => l.id },
  { header: 'name', get: (l) => l.name },
  { header: 'url', get: (l) => l.url },
  { header: 'description', get: (l) => l.description },
  { header: 'statusId', get: (l) => l.statusId },
  { header: 'ownerId', get: (l) => l.ownerId },
  { header: 'dnc', get: (l) => (l.dnc ? 'true' : 'false') },
  { header: 'lastContactedAt', get: (l) => l.lastContactedAt },
  { header: 'lastInboundAt', get: (l) => l.lastInboundAt },
  { header: 'nextTaskDueAt', get: (l) => l.nextTaskDueAt },
  { header: 'createdAt', get: (l) => l.createdAt },
  { header: 'updatedAt', get: (l) => l.updatedAt },
];

/** RFC-4180 cell quoting: wrap + double-up quotes when the value needs it. */
function csvCell(value: string | null): string {
  if (value === null) return '';
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize leads to CSV (CRLF line endings, quoted header row). */
export function leadsToCsv(rows: readonly RawLeadRow[]): string {
  const header = CSV_COLUMNS.map((c) => c.header).join(',');
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => csvCell(c.get(r))).join(','));
  return [header, ...lines].join('\r\n');
}

/** Serialize leads to a JSON array of Lead DTOs. */
export function leadsToJson(rows: readonly RawLeadRow[]): string {
  return JSON.stringify(rows);
}
