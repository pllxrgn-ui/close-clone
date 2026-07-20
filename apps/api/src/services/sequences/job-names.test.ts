import { describe, expect, test } from 'vitest';
import { SEND_JOB_NAME, wakeupJobId } from './job-names.ts';

/**
 * The wake-up id is the queue dedupe handle. Two properties are load-bearing for
 * the sequence engine's production (BullMQ) correctness — see the note in
 * job-names.ts. These lock them so the "deferred intents strand forever" and
 * "enroller/sweeper double-fire" regressions can't silently return.
 */
describe('wakeupJobId', () => {
  test('same intent + same due time → same id (enroller/sweeper self-heal dedupe)', () => {
    expect(wakeupJobId('intent-1', 1_700_000_000_000)).toBe(
      wakeupJobId('intent-1', 1_700_000_000_000),
    );
  });

  test('a deferral (advanced due time) mints a FRESH id — not swallowed by the active job', () => {
    const original = wakeupJobId('intent-1', 1_700_000_000_000);
    const deferred = wakeupJobId('intent-1', 1_700_000_086_400_000); // +1 day
    expect(deferred).not.toBe(original);
  });

  test('distinct intents never collide', () => {
    const due = 1_700_000_000_000;
    expect(wakeupJobId('intent-a', due)).not.toBe(wakeupJobId('intent-b', due));
  });

  test('the job name is stable', () => {
    expect(SEND_JOB_NAME).toBe('sequence:send');
  });
});
