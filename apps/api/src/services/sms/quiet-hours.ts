import { z } from 'zod';
import { localParts } from '../sequences/window.ts';

/**
 * Quiet-hours evaluation for outbound SMS (CONTRACTS §C6 I-QUIET). The normative
 * rule is stated directly in the contract: "no outbound SMS outside 8am–9pm
 * recipient-local (area-code inferred, fallback company tz)". This module is the
 * single authority for that check.
 *
 * The `org_settings.quiet_hours` jsonb is untyped in the shared contract
 * (`z.record`), so its concrete shape is pinned HERE. Because I-QUIET phrases the
 * rule as an ALLOWED sending window (8am–9pm), the jsonb is interpreted as an
 * optional override of that allowed window (not the "quiet" complement) — keeping
 * the field consistent with the sibling `sending_window` (email, §I-SEND-4):
 *
 *   { start?: "HH:MM",     // inclusive open of the allowed window (local wall clock)
 *     end?:   "HH:MM",     // exclusive close of the allowed window
 *     timezone?: string }  // overrides the resolved recipient/company tz if present
 *
 * Absent/empty ⇒ the I-QUIET default window 08:00–21:00. A missing `start`/`end`
 * falls back to the matching default bound, so an org can widen or narrow one edge.
 *
 * Timezone math reuses the DST-correct `localParts` helper (email window module),
 * so a recipient in a DST-observing zone is evaluated against real wall-clock time.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** I-QUIET default allowed-send window: 08:00 (inclusive) … 21:00 (exclusive). */
export const QUIET_HOURS_DEFAULT_START_MIN = 8 * 60;
export const QUIET_HOURS_DEFAULT_END_MIN = 21 * 60;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const quietHoursSchema = z.object({
  start: z.string().regex(HHMM).optional(),
  end: z.string().regex(HHMM).optional(),
  timezone: z.string().optional(),
});
export type QuietHoursConfig = z.infer<typeof quietHoursSchema>;

export interface QuietHoursWindow {
  /** Inclusive open of the allowed window, minutes since local midnight. */
  startMin: number;
  /** Exclusive close of the allowed window, minutes since local midnight. */
  endMin: number;
  /** Explicit tz override from the jsonb (else null → recipient/company tz). */
  timezoneOverride: string | null;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Resolve the effective allowed-send window from the `org_settings.quiet_hours`
 * jsonb, defaulting each unset bound to the I-QUIET default. A malformed jsonb is
 * treated as unset (defaults) rather than throwing — an SMS is never sent on a
 * config parse error, but the check itself must not crash the send path.
 */
export function parseQuietHours(raw: unknown): QuietHoursWindow {
  const base: QuietHoursWindow = {
    startMin: QUIET_HOURS_DEFAULT_START_MIN,
    endMin: QUIET_HOURS_DEFAULT_END_MIN,
    timezoneOverride: null,
  };
  if (raw === null || raw === undefined) return base;
  if (typeof raw === 'object' && Object.keys(raw as object).length === 0) return base;
  const parsed = quietHoursSchema.safeParse(raw);
  if (!parsed.success) return base;
  const cfg = parsed.data;
  return {
    startMin: cfg.start !== undefined ? toMinutes(cfg.start) : QUIET_HOURS_DEFAULT_START_MIN,
    endMin: cfg.end !== undefined ? toMinutes(cfg.end) : QUIET_HOURS_DEFAULT_END_MIN,
    timezoneOverride: cfg.timezone !== undefined && cfg.timezone.length > 0 ? cfg.timezone : null,
  };
}

/** Tz to evaluate the window in: jsonb override → recipient (area-code) → company. */
export function resolveQuietHoursTimezone(
  window: QuietHoursWindow,
  recipientTz: string | null,
  companyTz: string,
): string {
  if (window.timezoneOverride !== null) return window.timezoneOverride;
  if (recipientTz !== null && recipientTz.length > 0) return recipientTz;
  return companyTz.length > 0 ? companyTz : 'UTC';
}

/**
 * True iff `instant`, read in `tz`, falls inside the allowed send window — i.e. the
 * send is permitted. A false result means the instant is in the quiet period and
 * the SMS must be rejected/deferred (I-QUIET).
 */
export function isWithinAllowedHours(instant: Date, tz: string, window: QuietHoursWindow): boolean {
  const { minutes } = localParts(instant, tz);
  return minutes >= window.startMin && minutes < window.endMin;
}
