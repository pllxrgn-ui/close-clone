import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { webhookDeliveries } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { InProcessQueueDriver } from '../../queue/index.ts';
import { emitWebhookEvent } from './fanout.ts';
import {
  createWebhookDeliveryProcessor,
  processDelivery,
  safeDeliveryLog,
  type WebhookSendInput,
  type WebhookSender,
} from './delivery.ts';
import { SIGNATURE_HEADER, verifySignature } from './signing.ts';
import { type BackoffConfig } from './backoff.ts';
import { WebhookSubscriptionService } from './service.ts';

/**
 * Task 5c — the delivery worker: HMAC round-trip + tamper, retry with backoff,
 * dead-lettering after N, idempotency, queue-driven end-to-end, and log redaction.
 */

const BACKOFF: BackoffConfig = { baseMs: 100, factor: 2, maxMs: 10_000, maxAttempts: 3 };

let ctx: TestDb;
let svc: WebhookSubscriptionService;
const clock = { ms: Date.parse('2026-07-15T12:00:00.000Z') };

interface SenderHarness {
  sender: WebhookSender;
  calls: WebhookSendInput[];
}

/** A scriptable sender: `script(callNumber)` returns an HTTP status or 'throw'. */
function makeSender(script: (n: number) => number | 'throw'): SenderHarness {
  const calls: WebhookSendInput[] = [];
  const sender: WebhookSender = async (input) => {
    calls.push(input);
    const outcome = script(calls.length);
    if (outcome === 'throw') throw new Error('network down');
    return { status: outcome };
  };
  return { sender, calls };
}

function makeQueue(): InProcessQueueDriver {
  return new InProcessQueueDriver({ mode: 'manual', now: () => clock.ms });
}

async function stateOf(deliveryId: string): Promise<{
  state: string;
  attempts: number;
  nextRetryAt: string | null;
}> {
  const rows = await ctx.db
    .select({
      state: webhookDeliveries.state,
      attempts: webhookDeliveries.attempts,
      nextRetryAt: webhookDeliveries.nextRetryAt,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId));
  return rows[0]!;
}

beforeAll(async () => {
  ctx = await createTestDb();
  svc = new WebhookSubscriptionService(ctx.db);
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  clock.ms = Date.parse('2026-07-15T12:00:00.000Z');
  await ctx.db.execute(sql`DELETE FROM webhook_deliveries`);
  await ctx.db.execute(sql`DELETE FROM webhook_subscriptions`);
});

async function seedDelivery(events: string[] = ['lead.created']): Promise<{
  deliveryId: string;
  secret: string;
  subscriptionId: string;
}> {
  const { subscription, secret } = await svc.create({ url: 'https://h.test/hook', events });
  const queue = makeQueue();
  const { deliveryIds } = await emitWebhookEvent(
    { db: ctx.db, queue, now: () => new Date(clock.ms) },
    { type: 'lead.created', data: { leadId: 'L1' }, id: 'evt-x' },
  );
  return { deliveryId: deliveryIds[0]!, secret, subscriptionId: subscription.id };
}

describe('successful delivery + HMAC round-trip', () => {
  test('2xx → delivered; the sent signature verifies and detects tampering', async () => {
    const { deliveryId, secret } = await seedDelivery();
    const { sender, calls } = makeSender(() => 200);
    const queue = makeQueue();

    const result = await processDelivery(
      { db: ctx.db, sender, queue, now: () => new Date(clock.ms), backoff: BACKOFF },
      deliveryId,
    );
    expect(result.kind).toBe('delivered');
    expect(result.attempts).toBe(1);
    expect((await stateOf(deliveryId)).state).toBe('delivered');

    // Round-trip: the receiver can verify what we sent.
    const sent = calls[0]!;
    const header = sent.headers[SIGNATURE_HEADER]!;
    expect(verifySignature(secret, header, sent.body, { nowMs: () => clock.ms })).toBe(true);
    // Tamper: any body change breaks it.
    expect(verifySignature(secret, header, sent.body + '!', { nowMs: () => clock.ms })).toBe(false);
    // The signature is a MAC, not the secret — the secret never rides on the wire.
    expect(JSON.stringify(sent.headers)).not.toContain(secret);
  });
});

describe('retry with backoff', () => {
  test('a failure keeps it pending, bumps attempts, sets next_retry_at, re-enqueues', async () => {
    const { deliveryId } = await seedDelivery();
    const { sender } = makeSender(() => 500);
    const queue = makeQueue();

    const result = await processDelivery(
      { db: ctx.db, sender, queue, now: () => new Date(clock.ms), backoff: BACKOFF, rng: () => 0 },
      deliveryId,
    );
    expect(result.kind).toBe('retry_scheduled');
    expect(result.attempts).toBe(1);
    // rng=0 → equal-jitter floor = ceiling/2 = 100/2 = 50ms after now.
    expect(result.nextRetryAt).toBe(new Date(clock.ms + 50).toISOString());

    const row = await stateOf(deliveryId);
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.nextRetryAt).not.toBeNull();
    // A wake-up was queued for the retry.
    expect(queue.pendingCount).toBe(1);
  });
});

describe('dead-letter after N attempts', () => {
  test('exhausting maxAttempts drives the row to failed (terminal), no more retries', async () => {
    const { deliveryId } = await seedDelivery();
    const { sender, calls } = makeSender(() => 'throw'); // always fails
    const queue = makeQueue();
    const deps = {
      db: ctx.db,
      sender,
      queue,
      now: () => new Date(clock.ms),
      backoff: BACKOFF,
      rng: () => 0,
    };

    const r1 = await processDelivery(deps, deliveryId);
    const r2 = await processDelivery(deps, deliveryId);
    const r3 = await processDelivery(deps, deliveryId);

    expect(r1.kind).toBe('retry_scheduled');
    expect(r2.kind).toBe('retry_scheduled');
    expect(r3.kind).toBe('dead_lettered');
    expect(r3.attempts).toBe(3);

    const row = await stateOf(deliveryId);
    expect(row.state).toBe('failed'); // failed == dead-letter terminal (C1 enum)
    expect(row.attempts).toBe(3);
    expect(row.nextRetryAt).toBeNull();
    expect(calls).toHaveLength(3);

    // A dead-lettered row is terminal: re-processing is a no-op.
    const again = await processDelivery(deps, deliveryId);
    expect(again.kind).toBe('skipped');
    expect(calls).toHaveLength(3);
  });
});

describe('idempotency', () => {
  test('re-processing a delivered row does not send again', async () => {
    const { deliveryId } = await seedDelivery();
    const { sender, calls } = makeSender(() => 200);
    const queue = makeQueue();
    const deps = { db: ctx.db, sender, queue, now: () => new Date(clock.ms), backoff: BACKOFF };

    await processDelivery(deps, deliveryId);
    const second = await processDelivery(deps, deliveryId);
    expect(second.kind).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  test('a missing delivery id → skipped', async () => {
    const { sender } = makeSender(() => 200);
    const queue = makeQueue();
    const result = await processDelivery(
      { db: ctx.db, sender, queue, now: () => new Date(clock.ms) },
      '00000000-0000-4000-8000-0000000000ff',
    );
    expect(result.kind).toBe('skipped');
  });
});

describe('subscription deactivated mid-flight', () => {
  test('a queued delivery to a now-inactive subscription is retired without sending', async () => {
    const { deliveryId, subscriptionId } = await seedDelivery();
    await svc.update(subscriptionId, { isActive: false });
    const { sender, calls } = makeSender(() => 200);
    const queue = makeQueue();

    const result = await processDelivery(
      { db: ctx.db, sender, queue, now: () => new Date(clock.ms) },
      deliveryId,
    );
    expect(result.kind).toBe('dead_lettered');
    expect(calls).toHaveLength(0);
    expect((await stateOf(deliveryId)).state).toBe('failed');
  });
});

describe('queue-driven end-to-end', () => {
  test('emit → tick retries through backoff until a 2xx delivers it', async () => {
    const { subscription } = await svc.create({
      url: 'https://h.test/e2e',
      events: ['lead.created'],
    });
    const queue = makeQueue();
    // Fail twice, then succeed on the third attempt.
    const { sender, calls } = makeSender((n) => (n < 3 ? 500 : 200));
    queue.process(
      createWebhookDeliveryProcessor({
        db: ctx.db,
        sender,
        queue,
        now: () => new Date(clock.ms),
        backoff: BACKOFF,
        rng: () => 0,
      }),
    );

    const { deliveryIds } = await emitWebhookEvent(
      { db: ctx.db, queue, now: () => new Date(clock.ms) },
      { type: 'lead.created', data: {}, id: 'evt-e2e' },
    );
    const deliveryId = deliveryIds[0]!;

    // Attempt 1 (due now) → fails, schedules a retry.
    expect(await queue.tick(clock.ms)).toBe(1);
    expect((await stateOf(deliveryId)).state).toBe('pending');

    // Advance well past any backoff and drain retries until delivered.
    for (let i = 0; i < 5 && (await stateOf(deliveryId)).state === 'pending'; i += 1) {
      clock.ms += 10_000;
      await queue.tick(clock.ms);
    }

    expect((await stateOf(deliveryId)).state).toBe('delivered');
    expect(calls).toHaveLength(3);
    expect(subscription.isActive).toBe(true);
  });

  test('the processor ignores non-webhook jobs', async () => {
    const { sender, calls } = makeSender(() => 200);
    const processor = createWebhookDeliveryProcessor({
      db: ctx.db,
      sender,
      queue: makeQueue(),
      now: () => new Date(clock.ms),
    });
    await processor({ id: 'j1', name: 'sequence:send', data: { intentId: 'x' } });
    expect(calls).toHaveLength(0);
  });
});

describe('log redaction (D-021)', () => {
  test('safeDeliveryLog never emits the signing secret', () => {
    const log = safeDeliveryLog({
      deliveryId: 'd1',
      subscriptionId: 's1',
      url: 'https://h.test/hook',
      eventType: 'lead.created',
      attempt: 1,
      state: 'pending',
      status: 500,
      secret: 'whsec_TOP_SECRET_VALUE',
    });
    expect(log).not.toHaveProperty('secret');
    expect(JSON.stringify(log)).not.toContain('whsec_TOP_SECRET_VALUE');
    // The useful, non-sensitive fields survive.
    expect(log).toMatchObject({ deliveryId: 'd1', state: 'pending', status: 500 });
  });
});
