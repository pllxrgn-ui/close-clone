/**
 * Queue job-name + job-id conventions for the sequence engine (task 2e).
 * Centralised so the enroller, sweeper, and worker agree on the wake-up id — the
 * dedupe handle that makes the enroller's and the sweeper's enqueue collapse to a
 * single job per intent (ARCHITECTURE §4 self-heal).
 */

/** The only job name: "wake up and try to send this intent". */
export const SEND_JOB_NAME = 'sequence:send';

/**
 * Per-intent wake-up job id, scoped by the intent's current `due_at` (epoch ms).
 *
 * Two callers that target the SAME due time (the enroller and the sweeper) still
 * collapse to one job — the self-heal dedupe of ARCHITECTURE §4 is preserved.
 * But a *deferral* advances `due_at` (outside window / over cap / SMS quiet
 * hours), so `requeueDeferred` mints a NEW id. That distinction is load-bearing on
 * BullMQ: the re-enqueue runs from inside the still-active job, and BullMQ's jobId
 * uniqueness spans the active/completed sets — a stable `intent:<id>` would make
 * the re-enqueue a silent no-op and strand every deferred intent forever (the
 * in-process driver frees the id on fire, so this diverged only in production).
 * Scoping by `due_at` gives the deferral a fresh id while the active job holds the
 * old one. Dedupe is only an optimisation regardless: the send-once guarantee is
 * the `WHERE state='SCHEDULED'` claim in the send transaction, so a duplicate
 * wake-up bails harmlessly.
 */
export function wakeupJobId(intentId: string, dueAtMs: number): string {
  return `intent-${intentId}-${dueAtMs}`;
}
