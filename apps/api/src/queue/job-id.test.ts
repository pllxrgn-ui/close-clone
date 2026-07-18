import { describe, expect, test } from 'vitest';
import { wakeupJobId } from '../services/sequences/job-names.ts';
import { webhookDeliveryJobId } from '../services/webhooks/job-names.ts';

/*
 * BullMQ rejects a custom job id containing a colon ("Custom Id cannot contain
 * :") — it uses ':' as a Redis key separator. The in-process test queue driver
 * accepts anything, so this class of bug is invisible to the unit suites and
 * only surfaces against real Redis. This guard pins every custom job-id helper
 * to the BullMQ-safe charset so a colon can never regress in again.
 */
const BULLMQ_SAFE = /^[A-Za-z0-9_-]+$/;

describe('custom BullMQ job ids are valid (no colon — real-Redis constraint)', () => {
  const id = '11111111-2222-3333-4444-555555555555';

  test('sequence wake-up job id has no colon', () => {
    const jobId = wakeupJobId(id);
    expect(jobId).not.toContain(':');
    expect(jobId).toMatch(BULLMQ_SAFE);
  });

  test('webhook delivery job id has no colon', () => {
    const jobId = webhookDeliveryJobId(id);
    expect(jobId).not.toContain(':');
    expect(jobId).toMatch(BULLMQ_SAFE);
  });
});
