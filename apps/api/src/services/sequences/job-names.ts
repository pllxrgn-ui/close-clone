/**
 * Queue job-name + job-id conventions for the sequence engine (task 2e).
 * Centralised so the enroller, sweeper, and worker agree on the wake-up id — the
 * dedupe handle that makes the enroller's and the sweeper's enqueue collapse to a
 * single job per intent (ARCHITECTURE §4 self-heal).
 */

/** The only job name: "wake up and try to send this intent". */
export const SEND_JOB_NAME = 'sequence:send';

/** Stable per-intent wake-up job id (BullMQ/in-process dedupe key). */
export function wakeupJobId(intentId: string): string {
  return `intent-${intentId}`;
}
