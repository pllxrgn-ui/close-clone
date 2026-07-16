import { randomUUID } from 'node:crypto';
import type { EnqueueOptions, JobData, JobProcessor, QueueDriver, QueueJob } from './driver.ts';

/**
 * In-process {@link QueueDriver} for tests and MOCK_MODE (DECISIONS D-013). No
 * Redis, no other process.
 *
 * Two modes:
 *   - `'manual'` (tests): jobs accumulate; the test drives time by calling
 *     {@link InProcessQueueDriver.tick} with an explicit `now`. Fully
 *     deterministic — nothing fires on its own.
 *   - `'timer'` (MOCK_MODE runtime): jobs fire via `setTimeout` after their delay.
 *
 * `jobId` is the dedupe handle: a live job with a given id is scheduled once, so a
 * duplicate wake-up (enroller + sweeper both enqueue the same intent) collapses —
 * matching BullMQ and honouring ARCHITECTURE §4 (the queue is only a hint; the
 * send transaction is the authority).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

interface ScheduledJob {
  job: QueueJob;
  fireAt: number;
}

export interface InProcessQueueDriverOptions {
  /** `'manual'` (default) drives time via {@link InProcessQueueDriver.tick}. */
  mode?: 'manual' | 'timer';
  /** Injected clock (ms). Defaults to `Date.now`. Manual mode ignores it for
   *  firing decisions when a `now` is passed to `tick`. */
  now?: () => number;
}

export class InProcessQueueDriver implements QueueDriver {
  private readonly mode: 'manual' | 'timer';
  private readonly clock: () => number;
  private processor: JobProcessor | undefined;
  /** Pending jobs keyed by jobId (dedupe). */
  private readonly pending = new Map<string, ScheduledJob>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(options: InProcessQueueDriverOptions = {}) {
    this.mode = options.mode ?? 'manual';
    this.clock = options.now ?? (() => Date.now());
  }

  async enqueue(name: string, data: JobData, opts: EnqueueOptions = {}): Promise<void> {
    if (this.closed) throw new Error('InProcessQueueDriver: enqueue after close');
    const jobId = opts.jobId ?? randomUUID();
    // Dedupe: a live job with this id is scheduled exactly once (BullMQ parity).
    if (this.pending.has(jobId)) return;
    const delayMs = opts.delayMs ?? 0;
    const fireAt = this.clock() + Math.max(0, delayMs);
    const job: QueueJob = { id: jobId, name, data };
    this.pending.set(jobId, { job, fireAt });

    if (this.mode === 'timer') {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.fire(jobId);
      }, Math.max(0, delayMs));
      // Do not keep the event loop alive purely for a queued wake-up.
      if (typeof timer.unref === 'function') timer.unref();
      this.timers.add(timer);
    }
  }

  process(processor: JobProcessor): void {
    this.processor = processor;
  }

  /**
   * Run every job due at `now` (default: the injected clock), in `fireAt` order.
   * Returns the number of jobs processed. Manual-mode test driver.
   */
  async tick(now: number = this.clock()): Promise<number> {
    const due = [...this.pending.values()]
      .filter((s) => s.fireAt <= now)
      .sort((a, b) => a.fireAt - b.fireAt);
    let ran = 0;
    for (const scheduled of due) {
      // Guard against a job re-enqueued/removed by an earlier job in this tick.
      if (!this.pending.has(scheduled.job.id)) continue;
      this.pending.delete(scheduled.job.id);
      await this.runProcessor(scheduled.job);
      ran += 1;
    }
    return ran;
  }

  /** Number of jobs still waiting (test/inspection affordance). */
  get pendingCount(): number {
    return this.pending.size;
  }

  private async fire(jobId: string): Promise<void> {
    const scheduled = this.pending.get(jobId);
    if (scheduled === undefined) return;
    this.pending.delete(jobId);
    await this.runProcessor(scheduled.job);
  }

  private async runProcessor(job: QueueJob): Promise<void> {
    if (this.processor === undefined) {
      throw new Error(`InProcessQueueDriver: no processor registered for job ${job.name}`);
    }
    await this.processor(job);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }
}
