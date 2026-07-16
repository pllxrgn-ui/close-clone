import { z } from 'zod';

/**
 * Sending-window evaluation (CONTRACTS §C6 I-SEND-4). A sequence email may only
 * leave inside the org sending window, evaluated in the RECIPIENT's local
 * timezone with a fallback to the company timezone (`org_settings.company_timezone`).
 *
 * The window jsonb (`org_settings.sending_window`) is untyped in the shared
 * contract (`z.record`), so its concrete shape is pinned HERE:
 *
 *   { days?: number[0..6],   // 0=Sun … 6=Sat; absent ⇒ every day
 *     start: "HH:MM",        // inclusive open (wall clock, local tz)
 *     end:   "HH:MM",        // exclusive close
 *     timezone?: string }    // overrides the resolved tz if present
 *
 * A null/empty window means "no restriction" (always inside) — so unconfigured
 * orgs and the many suites that don't care about windows are never blocked.
 *
 * Timezone math is dependency-free via `Intl.DateTimeFormat` (real DST handling
 * for the in-window check). `minutesUntilOpen` is a wall-clock approximation used
 * only to pick a deferral time — it ignores DST transitions on the boundary day
 * (documented; max skew one hour, and it self-corrects because the deferred
 * attempt re-evaluates the exact in-window check).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const sendingWindowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).optional(),
  start: z.string().regex(HHMM),
  end: z.string().regex(HHMM),
  timezone: z.string().optional(),
});
export type SendingWindow = z.infer<typeof sendingWindowSchema>;

/** Parse the org jsonb into a window, or null when unset/empty (no restriction). */
export function parseSendingWindow(raw: unknown): SendingWindow | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object' && Object.keys(raw as object).length === 0) return null;
  const parsed = sendingWindowSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

interface LocalParts {
  /** 0=Sunday … 6=Saturday. */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Wall-clock weekday + minute-of-day for `instant` in `tz` (DST-correct). */
export function localParts(instant: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of fmt.formatToParts(instant)) {
    if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value] ?? 0;
    else if (part.type === 'hour')
      hour = Number(part.value) % 24; // '24' → 0 midnight
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return { weekday, minutes: hour * 60 + minute };
}

/** Resolve the tz to evaluate the window in: window override → recipient → company. */
export function resolveWindowTimezone(
  window: SendingWindow | null,
  recipientTz: string | null,
  companyTz: string,
): string {
  if (window?.timezone !== undefined && window.timezone.length > 0) return window.timezone;
  if (recipientTz !== null && recipientTz.length > 0) return recipientTz;
  return companyTz.length > 0 ? companyTz : 'UTC';
}

/** True iff `instant` falls inside `window` when read in `tz`. */
export function isInsideWindow(instant: Date, window: SendingWindow | null, tz: string): boolean {
  if (window === null) return true;
  const { weekday, minutes } = localParts(instant, tz);
  if (window.days !== undefined && !window.days.includes(weekday)) return false;
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  return minutes >= start && minutes < end;
}

/**
 * Wall-clock minutes from `instant` until the window next opens (0 if already
 * inside). Used to pick a deferral due-time; the deferred attempt re-runs the
 * exact {@link isInsideWindow} check, so a small DST approximation here is safe.
 */
export function minutesUntilOpen(instant: Date, window: SendingWindow | null, tz: string): number {
  if (window === null) return 0;
  if (isInsideWindow(instant, window, tz)) return 0;
  const { weekday, minutes } = localParts(instant, tz);
  const start = toMinutes(window.start);
  const days = window.days;
  const dayAllowed = (d: number): boolean => days === undefined || days.includes(d);

  for (let offset = 0; offset <= 7; offset += 1) {
    const day = (weekday + offset) % 7;
    if (!dayAllowed(day)) continue;
    if (offset === 0) {
      if (minutes < start) return start - minutes;
      // else today's window already passed (or we're inside, handled above) → next day
      continue;
    }
    return offset * 1440 - minutes + start;
  }
  // No allowed day found within a week (shouldn't happen for a real window) —
  // defer a day so the intent is retried rather than lost.
  return 1440;
}
