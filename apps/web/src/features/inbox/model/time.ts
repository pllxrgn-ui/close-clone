/*
 * Time anchoring + relative-time formatting for the Inbox.
 *
 * The whole surface is anchored to a FIXED "now" that mirrors the deterministic
 * fixture clock in `mocks/fixtures.ts` (REFERENCE_NOW = 2026-07-15T17:00Z). Every
 * overdue calculation, age label, and seeded timestamp resolves against this one
 * instant, so:
 *   - the inbox reads coherently with the leads board (the same amber/jade leads
 *     line up), and
 *   - queue state is stable regardless of wall-clock, which keeps tests free of
 *     fake timers and the demo identical every run.
 *
 * The real API would use `now()`; swapping this constant for `Date.now()` is the
 * only change needed to run against live data.
 */

/** Mirrors `REFERENCE_NOW` in mocks/fixtures.ts — the deterministic fixture clock. */
export const INBOX_NOW = new Date('2026-07-15T17:00:00.000Z');
export const INBOX_NOW_MS = INBOX_NOW.getTime();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The current anchored instant as an ISO string (what the mock stamps on writes). */
export function nowIso(): string {
  return INBOX_NOW.toISOString();
}

/** Start of the anchored "today" in UTC (matches the DB UTC anchoring, CONTRACTS C3). */
export function startOfToday(nowMs: number = INBOX_NOW_MS): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Start of the anchored "tomorrow" in UTC — the snooze target. */
export function startOfTomorrow(nowMs: number = INBOX_NOW_MS): number {
  return startOfToday(nowMs) + DAY;
}

/** True when `iso` falls on or after the start of the anchored today. */
export function isToday(iso: string | null, nowMs: number = INBOX_NOW_MS): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t >= startOfToday(nowMs) && t < startOfTomorrow(nowMs);
}

/**
 * Compact age label ("just now" / "3m" / "2h" / "5d" / "3w"). Always
 * non-negative — used for how long ago an inbound arrived or a step has waited.
 */
export function formatAge(iso: string | null, nowMs: number = INBOX_NOW_MS): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const delta = Math.max(0, nowMs - t);
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d`;
  return `${Math.floor(delta / (7 * DAY))}w`;
}

/**
 * Due-state label for a task. Past due within today → "due today"; past due on an
 * earlier day → "overdue Nd"; still in the future → "in Nh"/"in Nd".
 */
export function formatDue(dueAt: string | null, nowMs: number = INBOX_NOW_MS): string {
  if (!dueAt) return 'no due date';
  const t = Date.parse(dueAt);
  if (Number.isNaN(t)) return 'no due date';
  const delta = nowMs - t; // positive = overdue
  if (delta >= 0) {
    if (isToday(dueAt, nowMs)) return 'due today';
    const days = Math.max(1, Math.floor(delta / DAY));
    return `overdue ${days}d`;
  }
  const ahead = -delta;
  if (ahead < HOUR) return `in ${Math.max(1, Math.floor(ahead / MINUTE))}m`;
  if (ahead < DAY) return `in ${Math.floor(ahead / HOUR)}h`;
  return `in ${Math.floor(ahead / DAY)}d`;
}

/** Monospace wall-clock "HH:MM" (UTC) for timeline-style timestamps. */
export function formatClock(iso: string | null): string {
  if (!iso) return '--:--';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '--:--';
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Monospace short date "Jul 13" (UTC) for due dates further out. */
export function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const months = [
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
  const month = months[d.getUTCMonth()] ?? '';
  return `${month} ${d.getUTCDate()}`;
}
