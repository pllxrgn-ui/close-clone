import type { QueueDriver, QueueJob } from '../../queue/index.ts';
import { processTwilioInboxRow, type TelephonyProcessDeps } from './process.ts';

/**
 * Telephony worker wiring (DECISIONS D-013 QueueDriver). The ingress persists a
 * `webhook_inbox` row and enqueues a `twilio:process` wake-up; the processor maps
 * it to the timeline. Like the sequence engine, Postgres is authoritative and the
 * queue is only a wake-up — a lost/duplicated job is harmless because
 * `processTwilioInboxRow` is idempotent (the atomic inbox claim), and the sweeper
 * (`processPendingTwilioWebhooks`) self-heals any wake-up that was never delivered.
 *
 * `QueueDriver.process` is last-wins (one processor per driver), so this module
 * does NOT register its own — it exposes `handleTelephonyJob` for the composition
 * root to fold into its single combined processor alongside the sequence handler.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export const TWILIO_PROCESS_JOB = 'twilio:process';

export function twilioProcessJobId(inboxId: string): string {
  return `twilio:${inboxId}`;
}

/** Enqueue a wake-up for a freshly-persisted Twilio inbox row (idempotent jobId). */
export function enqueueTwilioProcess(queue: QueueDriver, inboxId: string): Promise<void> {
  return queue.enqueue(TWILIO_PROCESS_JOB, { inboxId }, { jobId: twilioProcessJobId(inboxId) });
}

/**
 * Handle a queue job iff it is a telephony job; returns true when handled. The
 * composition root calls this from its combined processor (see module doc).
 */
export async function handleTelephonyJob(
  deps: TelephonyProcessDeps,
  job: QueueJob,
): Promise<boolean> {
  if (job.name !== TWILIO_PROCESS_JOB) return false;
  const inboxId = job.data['inboxId'];
  if (typeof inboxId !== 'string' || inboxId.length === 0) return false;
  await processTwilioInboxRow(deps, inboxId);
  return true;
}
