import {
  processIntent,
  requeueDeferred,
  type DispatchDeps,
  type DispatchResult,
} from './dispatch.ts';
import { SEND_JOB_NAME } from './job-names.ts';

/**
 * Sequence worker wiring (task 2e). Binds the {@link QueueDriver} processor to the
 * send transaction: a `sequence:send` wake-up runs {@link processIntent}; a
 * `deferred` outcome (outside window / over cap) re-enqueues itself at the new due
 * time. Everything else is terminal in Postgres, so a lost wake-up is harmless —
 * the sweeper re-derives due work from rows (ARCHITECTURE §4).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type SequenceWorkerDeps = DispatchDeps;

/** Register the queue processor. Idempotent (driver keeps the last processor). */
export function registerSequenceWorker(deps: SequenceWorkerDeps): void {
  deps.queue.process(async (job) => {
    if (job.name !== SEND_JOB_NAME) return;
    const intentId = job.data['intentId'];
    if (typeof intentId !== 'string') return;
    const result: DispatchResult = await processIntent(deps, intentId);
    if (result.kind === 'deferred') await requeueDeferred(deps, intentId);
  });
}
