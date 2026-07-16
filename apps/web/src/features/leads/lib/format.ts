/*
 * Formatting helpers for the leads surface. Pure and deterministic: every
 * time-relative helper takes an explicit `now` so rendering and tests never
 * depend on the wall clock. Locale is pinned to en-US so digit grouping and
 * month names are stable across machines (tabular-nums alignment at the call
 * site handles the visual).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const dateShortFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const dateShortYearFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Midnight (local) of the given instant, as a millisecond epoch. */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Compact, glanceable relative time: `now`, `5m`, `3h`, `2d`, `4w`, then an
 * absolute `Mar 4` / `Mar 4, 2025`. Past renders bare (`3h ago` handled by the
 * caller via aria); future renders with a leading `in ` (`in 2d`) for due dates.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return '—';
  const diff = d.getTime() - now.getTime();
  const past = diff <= 0;
  const abs = Math.abs(diff);

  if (abs < MINUTE) return 'now';
  const stamp =
    abs < HOUR
      ? `${Math.floor(abs / MINUTE)}m`
      : abs < DAY
        ? `${Math.floor(abs / HOUR)}h`
        : abs < WEEK
          ? `${Math.floor(abs / DAY)}d`
          : abs < 4 * WEEK
            ? `${Math.floor(abs / WEEK)}w`
            : null;
  if (stamp === null) {
    return d.getFullYear() === now.getFullYear() ? dateShortFmt.format(d) : dateShortYearFmt.format(d);
  }
  return past ? stamp : `in ${stamp}`;
}

/** Full, unambiguous timestamp for tooltips / `title` / screen-reader text. */
export function formatDateTime(iso: string): string {
  const d = parse(iso);
  return d ? dateTimeFmt.format(d) : '—';
}

/** Short date (`Mar 4, 2026`) for close dates and other date-only fields. */
export function formatDate(iso: string): string {
  const d = parse(iso);
  return d ? dateShortYearFmt.format(d) : '—';
}

/**
 * Day-group heading for the timeline: `Today`, `Yesterday`, a weekday for the
 * last week, else an absolute date. Calendar-day comparison is done in local
 * time so "Today" tracks the viewer's day.
 */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return '—';
  const dayStart = startOfLocalDay(d);
  const nowStart = startOfLocalDay(now);
  const daysAgo = Math.round((nowStart - dayStart) / DAY);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo > 1 && daysAgo < 7) return weekdayFmt.format(d);
  return d.getFullYear() === now.getFullYear() ? dateShortFmt.format(d) : dateShortYearFmt.format(d);
}

/** A stable per-day key (local `YYYY-MM-DD`) for grouping timeline events. */
export function localDayKey(iso: string): string {
  const d = parse(iso);
  if (!d) return 'unknown';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Whole-dollar money from integer cents, e.g. `1_250_000` → `$12,500`. */
export function formatMoneyCents(cents: number, currency = 'USD'): string {
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });
  return fmt.format(cents / 100);
}

/** Compact money for dense cells, e.g. `$1.2M`, `$45K`, `$900`. */
export function formatMoneyCentsCompact(cents: number, currency = 'USD'): string {
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  return fmt.format(cents / 100);
}

/** Truncate to `max` chars with an ellipsis, on a word boundary where possible. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const head = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${head.trimEnd()}…`;
}
