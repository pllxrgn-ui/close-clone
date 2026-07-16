/*
 * Small presentation helpers for opportunity cards.
 *
 * Dates are compared on the UTC calendar date to match the CONTRACTS §C3
 * timezone anchoring (date-only values anchor at UTC midnight). ISO date strings
 * ('YYYY-MM-DD') sort lexicographically, so "is this past?" is a string compare
 * — no Date parsing, no local-timezone drift.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** 1–2 letter uppercase initials for an owner avatar chip. */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return '?';
  const second = words[1];
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ''}${second[0] ?? ''}`.toUpperCase();
}

/** The UTC calendar date of `now`, as 'YYYY-MM-DD'. */
export function todayIsoUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** True when a close date is strictly before today (UTC) — the "overdue" amber. */
export function isPastDate(closeDate: string | null, now: Date): boolean {
  if (!closeDate) return false;
  return closeDate < todayIsoUtc(now);
}

/** Compact human close date, e.g. "Jul 15". Falls back to the raw value. */
export function formatCloseDate(closeDate: string | null): string {
  if (!closeDate) return '—';
  const parts = closeDate.split('-');
  const month = MONTHS[Number(parts[1]) - 1];
  const day = parts[2];
  if (!month || day === undefined) return closeDate;
  return `${month} ${Number(day)}`;
}
