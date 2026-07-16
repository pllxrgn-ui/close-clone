/**
 * QueueDriver — the thin wake-up abstraction over BullMQ (DECISIONS D-013).
 *
 * ARCHITECTURE §4 is explicit that Postgres is authoritative and BullMQ is only a
 * "wake-up call": every job is re-derivable from `send_intents` rows, so NO
 * invariant depends on the queue. That lets us run two interchangeable drivers
 * behind one interface:
 *
 *   - {@link InProcessQueueDriver} — timers (MOCK_MODE runtime) or a manual `tick`
 *     (deterministic tests). Zero external services.
 *   - `BullmqQueueDriver` — production, backed by Redis. Compiles + unit-tested
 *     with an injected fake connection here; integration-tested in CI/compose
 *     where Redis exists (D-013, HUMAN_TODO).
 *
 * A job carries a `name` (the logical task, e.g. `sequence:send`) and a plain
 * JSON `data` payload (e.g. `{ intentId }`). `jobId` is the idempotency handle:
 * enqueuing the same `jobId` twice is a single job (BullMQ semantics — a lost or
 * duplicated wake-up is harmless because the send transaction re-checks state).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type JobData = Record<string, unknown>;

export interface QueueJob {
  /** Stable job id (BullMQ dedupe key). */
  id: string;
  /** Logical task name the processor switches on. */
  name: string;
  data: JobData;
}

export type JobProcessor = (job: QueueJob) => Promise<void>;

export interface EnqueueOptions {
  /** Delay before the job becomes runnable, in milliseconds (default 0). */
  delayMs?: number;
  /**
   * Idempotency handle. Re-enqueuing a live job with the same id is a no-op, so a
   * per-intent wake-up (`jobId = intent:<id>`) is scheduled at most once even if
   * both the enroller and the sweeper try (ARCHITECTURE §4 self-heal).
   */
  jobId?: string;
}

/**
 * The wake-up surface the sequence engine depends on. Deliberately minimal —
 * enqueue a (possibly delayed) job, register the single processor, and shut down.
 */
export interface QueueDriver {
  enqueue(name: string, data: JobData, opts?: EnqueueOptions): Promise<void>;
  /** Register the processor invoked for every job. Idempotent (last wins). */
  process(processor: JobProcessor): void;
  close(): Promise<void>;
}
