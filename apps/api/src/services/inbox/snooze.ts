import { startOfTomorrowMs } from './time.ts';
import type { SnoozeResult } from './types.ts';

/**
 * Snooze — a pure compute-and-return. Per CONTRACTS §C7 D-030 the inbox snooze is
 * a "UI-side deferral until next day; NOT persisted server-side in v1", so this
 * endpoint acknowledges the request with the next-day boundary and holds no server
 * state (no schema column exists for it, by design). The web performs the deferral.
 */
export function computeSnooze(itemId: string, nowMs: number): SnoozeResult {
  return { id: itemId, snoozedUntil: new Date(startOfTomorrowMs(nowMs)).toISOString() };
}
