import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { webhookDeliveries } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { InProcessQueueDriver } from '../../queue/index.ts';
import { emitWebhookEvent, sweepPendingWebhookDeliveries } from './fanout.ts';
import { WEBHOOK_DELIVERY_JOB } from './job-names.ts';
import { WebhookSubscriptionService } from './service.ts';

/**
 * Task 5c — fan-out. Only ACTIVE, selector-matching subscriptions get a delivery
 * row; each row is enqueued exactly once; the stored envelope is self-contained.
 */

let ctx: TestDb;
let svc: WebhookSubscriptionService;
let queue: InProcessQueueDriver;
const now = () => new Date('2026-07-15T12:00:00.000Z');

beforeAll(async () => {
  ctx = await createTestDb();
  svc = new WebhookSubscriptionService(ctx.db);
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM webhook_deliveries`);
  await ctx.db.execute(sql`DELETE FROM webhook_subscriptions`);
  queue = new InProcessQueueDriver({ mode: 'manual', now: () => now().getTime() });
});

async function deliveriesFor(subscriptionId: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, subscriptionId));
  return rows.length;
}

describe('emitWebhookEvent', () => {
  test('fans out to matching active subscriptions only', async () => {
    const matching = await svc.create({ url: 'https://h.test/a', events: ['lead.created'] });
    const wildcard = await svc.create({ url: 'https://h.test/b', events: ['*'] });
    const nonMatching = await svc.create({
      url: 'https://h.test/c',
      events: ['opportunity.closed'],
    });
    const inactive = await svc.create({ url: 'https://h.test/d', events: ['lead.created'] });
    await svc.update(inactive.subscription.id, { isActive: false });

    const result = await emitWebhookEvent(
      { db: ctx.db, queue, now },
      { type: 'lead.created', data: { leadId: 'L1' }, id: 'evt-1' },
    );

    expect(result.eventId).toBe('evt-1');
    expect(result.deliveryIds).toHaveLength(2); // matching + wildcard
    expect(await deliveriesFor(matching.subscription.id)).toBe(1);
    expect(await deliveriesFor(wildcard.subscription.id)).toBe(1);
    expect(await deliveriesFor(nonMatching.subscription.id)).toBe(0);
    expect(await deliveriesFor(inactive.subscription.id)).toBe(0);

    // One wake-up per delivery.
    expect(queue.pendingCount).toBe(2);
  });

  test('stores a self-contained envelope (id/type/occurredAt/data), state pending', async () => {
    const sub = await svc.create({
      url: 'https://h.test/a',
      events: ['opportunity.stage_changed'],
    });
    const { deliveryIds } = await emitWebhookEvent(
      { db: ctx.db, queue, now },
      { type: 'opportunity.stage_changed', data: { oppId: 'O1', to: 'won' }, id: 'evt-2' },
    );
    const row = await ctx.db
      .select({
        event: webhookDeliveries.event,
        state: webhookDeliveries.state,
        attempts: webhookDeliveries.attempts,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryIds[0]!));
    expect(row[0]!.state).toBe('pending');
    expect(row[0]!.attempts).toBe(0);
    expect(row[0]!.event).toMatchObject({
      id: 'evt-2',
      type: 'opportunity.stage_changed',
      occurredAt: '2026-07-15T12:00:00.000Z',
      data: { oppId: 'O1', to: 'won' },
    });
    expect(sub.subscription.isActive).toBe(true);
  });

  test('no matching subscription → no-op (no rows, no jobs)', async () => {
    await svc.create({ url: 'https://h.test/a', events: ['lead.created'] });
    const result = await emitWebhookEvent(
      { db: ctx.db, queue, now },
      { type: 'activity.recorded', data: {} },
    );
    expect(result.deliveryIds).toHaveLength(0);
    expect(queue.pendingCount).toBe(0);
  });

  test('enqueues under the webhook delivery job name', async () => {
    await svc.create({ url: 'https://h.test/a', events: ['lead.created'] });
    const seen: string[] = [];
    queue.process(async (job) => {
      seen.push(job.name);
    });
    await emitWebhookEvent({ db: ctx.db, queue, now }, { type: 'lead.created', data: {} });
    await queue.tick(now().getTime());
    expect(seen).toEqual([WEBHOOK_DELIVERY_JOB]);
  });
});

describe('sweepPendingWebhookDeliveries (transactional-outbox relay)', () => {
  async function seedDelivery(
    subId: string,
    state: 'pending' | 'delivered' | 'failed',
    nextRetryAt: string,
  ): Promise<string> {
    const [row] = await ctx.db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: subId,
        event: { id: 'e', type: 'activity.recorded', occurredAt: nextRetryAt, data: {} },
        state,
        attempts: 0,
        nextRetryAt,
      })
      .returning({ id: webhookDeliveries.id });
    if (!row) throw new Error('seed failed');
    return row.id;
  }

  test('enqueues committed pending rows that are due, skipping delivered ones', async () => {
    const sub = await svc.create({ url: 'https://h.test/a', events: ['activity.recorded'] });
    await seedDelivery(sub.subscription.id, 'pending', '2026-07-15T11:59:00.000Z'); // due
    await seedDelivery(sub.subscription.id, 'delivered', '2026-07-15T11:59:00.000Z'); // done

    const count = await sweepPendingWebhookDeliveries(ctx.db, queue, now);

    expect(count).toBe(1);
    expect(queue.pendingCount).toBe(1);
  });

  test('does not enqueue a pending row whose retry is still in the future', async () => {
    const sub = await svc.create({ url: 'https://h.test/a', events: ['activity.recorded'] });
    await seedDelivery(sub.subscription.id, 'pending', '2026-07-15T13:00:00.000Z'); // future

    const count = await sweepPendingWebhookDeliveries(ctx.db, queue, now);

    expect(count).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  test('is idempotent — a second sweep does not double-enqueue the same delivery', async () => {
    const sub = await svc.create({ url: 'https://h.test/a', events: ['activity.recorded'] });
    await seedDelivery(sub.subscription.id, 'pending', '2026-07-15T11:59:00.000Z');

    await sweepPendingWebhookDeliveries(ctx.db, queue, now);
    await sweepPendingWebhookDeliveries(ctx.db, queue, now);

    expect(queue.pendingCount).toBe(1); // jobId dedupe
  });
});
