import type { EnqueueOptions, JobData, JobProcessor, QueueDriver, QueueJob } from './driver.ts';

/**
 * BullMQ-backed {@link QueueDriver} for production (DECISIONS D-013). Redis is
 * absent on the build host, so this module is written to COMPILE and be
 * unit-tested against injected fakes; the real Redis round-trip is exercised only
 * in CI/compose (HUMAN_TODO).
 *
 * The BullMQ `Queue`/`Worker` classes are reached through injectable factories
 * ({@link BullmqQueueDriverDeps}) whose defaults construct the real thing. Tests
 * pass in-memory fakes, so no connection is opened and the option-mapping
 * (delay → `delay`, jobId → `jobId`, name → job name) is asserted directly.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** The subset of BullMQ `Queue` this driver uses. */
export interface QueueLike {
  add(name: string, data: JobData, opts?: { delay?: number; jobId?: string }): Promise<unknown>;
  close(): Promise<void>;
}

/** The BullMQ job shape the worker processor receives. */
export interface BullmqJobLike {
  id?: string | null;
  name: string;
  data: JobData;
}

/** The subset of BullMQ `Worker` this driver uses. */
export interface WorkerLike {
  close(): Promise<void>;
}

export interface BullmqQueueDriverDeps {
  /** Queue name (BullMQ). Default `'sequences'`. */
  queueName?: string;
  /** Builds the queue; default wires the real BullMQ `Queue`. */
  queueFactory: (queueName: string) => QueueLike;
  /**
   * Builds the worker bound to `processor`; default wires the real BullMQ
   * `Worker`. Called lazily on the first {@link BullmqQueueDriver.process} so a
   * driver that only enqueues never starts a consumer.
   */
  workerFactory: (
    queueName: string,
    processor: (job: BullmqJobLike) => Promise<void>,
  ) => WorkerLike;
}

export class BullmqQueueDriver implements QueueDriver {
  private readonly queueName: string;
  private readonly queue: QueueLike;
  private readonly workerFactory: BullmqQueueDriverDeps['workerFactory'];
  private worker: WorkerLike | undefined;

  constructor(deps: BullmqQueueDriverDeps) {
    this.queueName = deps.queueName ?? 'sequences';
    this.queue = deps.queueFactory(this.queueName);
    this.workerFactory = deps.workerFactory;
  }

  async enqueue(name: string, data: JobData, opts: EnqueueOptions = {}): Promise<void> {
    const addOpts: { delay?: number; jobId?: string } = {};
    if (opts.delayMs !== undefined && opts.delayMs > 0) addOpts.delay = opts.delayMs;
    if (opts.jobId !== undefined) addOpts.jobId = opts.jobId;
    await this.queue.add(name, data, addOpts);
  }

  process(processor: JobProcessor): void {
    // Adapt a BullMQ job to the driver-neutral QueueJob the processor expects.
    const adapt = async (job: BullmqJobLike): Promise<void> => {
      const queueJob: QueueJob = { id: job.id ?? '', name: job.name, data: job.data };
      await processor(queueJob);
    };
    // Replace any prior worker (last registration wins, matching the interface).
    this.worker = this.workerFactory(this.queueName, adapt);
  }

  async close(): Promise<void> {
    if (this.worker !== undefined) await this.worker.close();
    await this.queue.close();
  }
}
