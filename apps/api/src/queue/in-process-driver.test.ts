import { describe, expect, test } from 'vitest';
import { InProcessQueueDriver } from './in-process-driver.ts';
import type { QueueJob } from './driver.ts';

/**
 * In-process driver (DECISIONS D-013): deterministic manual-tick semantics that
 * the sequence suites depend on — delay gating, jobId dedupe, fire order, and the
 * no-processor / after-close failure paths.
 */

describe('InProcessQueueDriver (manual mode)', () => {
  test('does not fire a delayed job until its due time', async () => {
    const clock = 1000;
    const d = new InProcessQueueDriver({ now: () => clock });
    const seen: string[] = [];
    d.process(async (job) => {
      seen.push(job.id);
    });
    await d.enqueue('sequence:send', { intentId: 'a' }, { delayMs: 500, jobId: 'j1' });

    expect(await d.tick(1200)).toBe(0); // before due (1000+500=1500)
    expect(seen).toEqual([]);
    expect(await d.tick(1500)).toBe(1); // exactly due
    expect(seen).toEqual(['j1']);
    expect(d.pendingCount).toBe(0);
  });

  test('dedupes by jobId — a duplicate wake-up is a single job', async () => {
    const d = new InProcessQueueDriver({ now: () => 0 });
    let count = 0;
    d.process(async () => {
      count += 1;
    });
    await d.enqueue('sequence:send', { intentId: 'x' }, { jobId: 'intent:x' });
    await d.enqueue('sequence:send', { intentId: 'x' }, { jobId: 'intent:x' });
    expect(d.pendingCount).toBe(1);
    await d.tick(0);
    expect(count).toBe(1);
  });

  test('runs due jobs in fireAt order', async () => {
    const clock = 0;
    const d = new InProcessQueueDriver({ now: () => clock });
    const order: string[] = [];
    d.process(async (job: QueueJob) => {
      order.push(String(job.data['n']));
    });
    await d.enqueue('t', { n: 'late' }, { delayMs: 300, jobId: 'late' });
    await d.enqueue('t', { n: 'early' }, { delayMs: 100, jobId: 'early' });
    await d.enqueue('t', { n: 'mid' }, { delayMs: 200, jobId: 'mid' });
    await d.tick(1000);
    expect(order).toEqual(['early', 'mid', 'late']);
  });

  test('a job re-enqueued with a fresh id after firing runs again', async () => {
    const clock = 0;
    const d = new InProcessQueueDriver({ now: () => clock });
    let runs = 0;
    d.process(async () => {
      runs += 1;
    });
    await d.enqueue('t', {}, { jobId: 'once' });
    await d.tick(0);
    // Same id after it already fired: allowed again (no longer pending).
    await d.enqueue('t', {}, { jobId: 'once' });
    await d.tick(0);
    expect(runs).toBe(2);
  });

  test('throws when no processor is registered', async () => {
    const d = new InProcessQueueDriver({ now: () => 0 });
    await d.enqueue('t', {}, { jobId: 'j' });
    await expect(d.tick(0)).rejects.toThrow(/no processor/);
  });

  test('enqueue after close throws', async () => {
    const d = new InProcessQueueDriver({ now: () => 0 });
    await d.close();
    await expect(d.enqueue('t', {}, { jobId: 'j' })).rejects.toThrow(/after close/);
  });
});
