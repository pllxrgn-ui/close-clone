/**
 * Time anchoring for the inbox projection. Every overdue / done-today calculation
 * resolves against one injected instant so the merge + counters are deterministic
 * (tests pass a fixed `now`; the route uses `new Date()`). Day boundaries are UTC
 * to match the DB session pinning (CONTRACTS §C3) and the web's `model/time.ts`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the anchored "today" in UTC, as epoch ms. */
export function startOfTodayMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Start of the anchored "tomorrow" in UTC, as epoch ms (the snooze target). */
export function startOfTomorrowMs(nowMs: number): number {
  return startOfTodayMs(nowMs) + DAY_MS;
}

/** True when `iso` falls on or after the start of today and before tomorrow. */
export function isToday(iso: string | null, nowMs: number): boolean {
  if (iso === null) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t >= startOfTodayMs(nowMs) && t < startOfTomorrowMs(nowMs);
}
