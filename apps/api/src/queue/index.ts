import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import {
  BullmqQueueDriver,
  type BullmqJobLike,
  type QueueLike,
  type WorkerLike,
} from './bullmq-driver.ts';

/**
 * Queue layer barrel (DECISIONS D-013). Exposes the driver interface, both
 * implementations, and a production wiring helper.
 *
 * The composition root chooses the driver by mode: MOCK_MODE / tests use the
 * in-process driver; production uses {@link createBullmqQueueDriver} (real Redis).
 * Nothing above the driver line branches on the choice — the sequence engine only
 * ever sees a `QueueDriver`.
 */

export type { JobData, QueueJob, JobProcessor, EnqueueOptions, QueueDriver } from './driver.ts';
export { InProcessQueueDriver, type InProcessQueueDriverOptions } from './in-process-driver.ts';
export {
  BullmqQueueDriver,
  type BullmqQueueDriverDeps,
  type QueueLike,
  type WorkerLike,
  type BullmqJobLike,
} from './bullmq-driver.ts';

export interface CreateBullmqOptions {
  /** ioredis connection options (host/port/etc). */
  connection: ConnectionOptions;
  /** Queue name; default `'sequences'`. */
  queueName?: string;
}

/**
 * Wire a {@link BullmqQueueDriver} to real BullMQ `Queue`/`Worker`. Used only in
 * the production composition root (Redis present); never in tests or MOCK_MODE.
 */
export function createBullmqQueueDriver(options: CreateBullmqOptions): BullmqQueueDriver {
  const { connection } = options;
  return new BullmqQueueDriver({
    ...(options.queueName !== undefined ? { queueName: options.queueName } : {}),
    queueFactory: (name): QueueLike => new Queue(name, { connection }),
    workerFactory: (name, processor): WorkerLike =>
      new Worker(
        name,
        async (job): Promise<void> => {
          const adapted: BullmqJobLike = { id: job.id ?? null, name: job.name, data: job.data };
          await processor(adapted);
        },
        { connection },
      ),
  });
}
