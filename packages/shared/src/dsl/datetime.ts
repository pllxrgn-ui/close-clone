/**
 * Relative-date resolution for the Smart View compiler (CONTRACTS §C3:
 * "relative dates resolve at execution time in org timezone").
 *
 * Uses the platform `Intl` API for timezone math — no external date dependency.
 * Absolute durations (h/d/w) are wall-clock independent; month math and the
 * `today`/`this_week`/`this_month` anchors are computed against the org-local
 * calendar. DST edges are refined once; sub-hour precision at a DST boundary is
 * out of scope (DB-backed goldens are task 1d).
 */
import type { Relative, RelativeUnit } from './ast.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

interface LocalParts {
  y: number;
  mo: number; // 1-based
  da: number;
  h: number;
  mi: number;
  s: number;
}

function partsInTz(date: Date, tz: string): LocalParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  const hour = out.hour === '24' ? 0 : Number(out.hour);
  return {
    y: Number(out.year),
    mo: Number(out.month),
    da: Number(out.day),
    h: hour,
    mi: Number(out.minute),
    s: Number(out.second),
  };
}

function offsetMs(date: Date, tz: string): number {
  const p = partsInTz(date, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.da, p.h, p.mi, p.s);
  return asUtc - date.getTime();
}

/** Build the UTC instant corresponding to a given org-local wall-clock time. */
function instantFromLocal(p: LocalParts, tz: string): Date {
  const guessUtc = Date.UTC(p.y, p.mo - 1, p.da, p.h, p.mi, p.s);
  const off1 = offsetMs(new Date(guessUtc), tz);
  let instant = guessUtc - off1;
  const off2 = offsetMs(new Date(instant), tz);
  if (off2 !== off1) instant = guessUtc - off2;
  return new Date(instant);
}

function daysInMonth(y: number, mo1: number): number {
  return new Date(Date.UTC(y, mo1, 0)).getUTCDate();
}

function weekdayInTz(date: Date, tz: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  return idx < 0 ? 0 : idx;
}

function startOfDay(now: Date, tz: string): Date {
  const p = partsInTz(now, tz);
  return instantFromLocal({ ...p, h: 0, mi: 0, s: 0 }, tz);
}

function startOfMonth(now: Date, tz: string): Date {
  const p = partsInTz(now, tz);
  return instantFromLocal({ ...p, da: 1, h: 0, mi: 0, s: 0 }, tz);
}

function startOfWeek(now: Date, tz: string): Date {
  const dow = weekdayInTz(now, tz); // 0=Sun..6=Sat
  const sinceMonday = dow === 0 ? 6 : dow - 1; // ISO week starts Monday
  return new Date(startOfDay(now, tz).getTime() - sinceMonday * DAY);
}

function subMonths(now: Date, n: number, tz: string): Date {
  const p = partsInTz(now, tz);
  let monthIdx = p.mo - 1 - n;
  const y = p.y + Math.floor(monthIdx / 12);
  monthIdx = ((monthIdx % 12) + 12) % 12;
  const da = Math.min(p.da, daysInMonth(y, monthIdx + 1));
  return instantFromLocal({ y, mo: monthIdx + 1, da, h: p.h, mi: p.mi, s: p.s }, tz);
}

function subAbsolute(now: Date, n: number, unit: Exclude<RelativeUnit, 'mo'>): Date {
  const per = unit === 'h' ? HOUR : unit === 'd' ? DAY : WEEK;
  return new Date(now.getTime() - n * per);
}

/** Resolve a `within N unit` cutoff to a UTC instant. */
export function resolveWithin(n: number, unit: RelativeUnit, now: Date, tz: string): Date {
  return unit === 'mo' ? subMonths(now, n, tz) : subAbsolute(now, n, unit);
}

/** Resolve a relative-date value (`N unit ago` | today | this_week | this_month). */
export function resolveRelative(rel: Relative, now: Date, tz: string): Date {
  if (rel.form === 'named') {
    switch (rel.name) {
      case 'today':
        return startOfDay(now, tz);
      case 'this_week':
        return startOfWeek(now, tz);
      case 'this_month':
        return startOfMonth(now, tz);
    }
  }
  return resolveWithin(rel.n, rel.unit, now, tz);
}
