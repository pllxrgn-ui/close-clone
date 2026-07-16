import { localParts } from './window.ts';
import type { QuietHoursWindow } from '../sms/quiet-hours.ts';

/**
 * Deferral-time helper for the SMS quiet-hours rail (CONTRACTS §C6 I-QUIET). The
 * `services/sms/quiet-hours` module owns the normative "is this instant inside the
 * allowed 8am–9pm window" check; this is the wall-clock companion the SEQUENCE
 * dispatcher uses to pick a defer due-time when an SMS step comes due OUTSIDE the
 * window (mirroring the email `minutesUntilOpen`, §I-SEND-4).
 *
 * Approximate on DST-boundary days (max one hour skew) and self-correcting: the
 * deferred attempt re-runs the exact `isWithinAllowedHours` check, so an SMS is
 * never actually sent outside the window — the worst case is one extra deferral.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/**
 * Wall-clock minutes from `instant` (read in `tz`) until the allowed SMS window
 * next opens; 0 when already inside. The quiet-hours window has no per-day mask
 * (unlike the email sending window), so the next open is either later today (when
 * before the open bound) or tomorrow's open bound (when at/after the close bound).
 */
export function minutesUntilQuietOpen(instant: Date, tz: string, window: QuietHoursWindow): number {
  const { minutes } = localParts(instant, tz);
  if (minutes >= window.startMin && minutes < window.endMin) return 0;
  if (minutes < window.startMin) return window.startMin - minutes;
  // At/after today's close bound → wrap to tomorrow's open bound.
  return 1440 - minutes + window.startMin;
}
