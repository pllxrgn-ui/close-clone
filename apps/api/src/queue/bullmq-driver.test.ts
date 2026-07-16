import { describe, expect, test } from 'vitest';
import { BullmqQueueDriver, type BullmqJobLike, type QueueLike, type WorkerLike } from './bullmq-driver.ts';

/**
 * BullMQ driver (DECISIONS D-013): NO Redis on the host, so this asserts the
 * option-mapping and processor adaptation against injected fakes. The real Redis
 * round-trip is a CI/compose HUMAN_TODO.
 */

interface AddCall {
  name: string;
  data: Record<string, unknown>;
  opts?: { delay?: number; jobId?: string };
}

class FakeQueue implements QueueLike {
  readonly adds: AddCall[] = [];
  closed = false;
  async add(
    name: string,
    data: Record<string, unknown>,
    opts?: { delay?: number; jobId?: string },
  ): Promise<unknown> {
    this.adds.push({ name, data, ...(opts !== undefined ? { opts } : {}) });
    return { id: opts?.jobId ?? 'auto' };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeWorker implements WorkerLike {
  closed = false;
  constructor(readonly processor: (job: BullmqJobLike) => Promise<void>) {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

function build(): { driver: BullmqQueueDriver; queue: FakeQueue; workers: FakeWorker[] } {
  const queue = new FakeQueue();
  const workers: FakeWorker[] = [];
  const driver = new BullmqQueueDriver({
    queueName: 'sequences',
    queueFactory: () => queue,
    workerFactory: (_name, processor) => {
      const w = new FakeWorker(processor);
      workers.push(w);
      return w;
    },
  });
  return { driver, queue, workers };
}

describe('BullmqQueueDriver', () => {
  test('maps delayMs and jobId onto BullMQ add options', async () => {
    const { driver, queue } = build();
    await driver.enqueue('sequence:send', { intentId: 'i1' }, { delayMs: 5000, jobId: 'intent:i1' });
    expect(queue.adds).toHaveLength(1);
    expect(queue.adds[0]).toEqual({
      name: 'sequence:send',
      data: { intentId: 'i1' },
      opts: { delay: 5000, jobId: 'intent:i1' },
    });
  });

  test('omits delay when zero/absent', async () => {
    const { driver, queue } = build();
    await driver.enqueue('sequence:send', { intentId: 'i2' }, { jobId: 'intent:i2' });
    expect(queue.adds[0]!.opts).toEqual({ jobId: 'intent:i2' });
  });

  test('process wires a worker that adapts the BullMQ job to a QueueJob', async () => {
    const { driver, workers } = build();
    const received: { id: string; name: string; data: Record<string, unknown> }[] = [];
    driver.process(async (job) => {
      received.push({ id: job.id, name: job.name, data: job.data });
    });
    expect(workers).toHaveLength(1);
    await workers[0]!.processor({ id: 'j-9', name: 'sequence:send', data: { intentId: 'x' } });
    expect(received).toEqual([{ id: 'j-9', name: 'sequence:send', data: { intentId: 'x' } }]);
  });

  test('adapts a null BullMQ job id to an empty string', async () => {
    const { driver, workers } = build();
    let seenId = 'unset';
    driver.process(async (job) => {
      seenId = job.id;
    });
    await workers[0]!.processor({ id: null, name: 'n', data: {} });
    expect(seenId).toBe('');
  });

  test('close shuts down worker and queue', async () => {
    const { driver, queue, workers } = build();
    driver.process(async () => {});
    await driver.close();
    expect(queue.closed).toBe(true);
    expect(workers[0]!.closed).toBe(true);
  });
});
