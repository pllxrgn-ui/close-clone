import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';

import { webhookDeliveries, webhookSubscriptions } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import {
  WebhookHasDeliveriesError,
  WebhookSubscriptionNotFoundError,
  WebhookValidationError,
} from './errors.ts';
import { WebhookSubscriptionService } from './service.ts';

/**
 * Task 5c — webhook subscription CRUD (PGlite). Secret shown once + never on read,
 * selector validation, keyset list, rotate, and the delete-vs-ledger rule.
 */

let ctx: TestDb;
let svc: WebhookSubscriptionService;

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
});

describe('create', () => {
  test('returns the secret once; the view has no secret; events normalized', async () => {
    const { subscription, secret } = await svc.create({
      url: 'https://hooks.example.com/switchboard',
      events: ['lead.created', 'lead.created', 'opportunity.closed'],
    });
    expect(secret).toMatch(/^whsec_/);
    expect(subscription.events).toEqual(['lead.created', 'opportunity.closed']);
    expect(subscription.isActive).toBe(true);
    expect(subscription).not.toHaveProperty('secret');

    // The secret IS persisted (for signing) but never surfaced by the view.
    const stored = await ctx.db
      .select({ secret: webhookSubscriptions.secret })
      .from(webhookSubscriptions)
      .where(sql`${webhookSubscriptions.id} = ${subscription.id}`);
    expect(stored[0]!.secret).toBe(secret);
  });

  test('accepts a bring-your-own secret + wildcard selector', async () => {
    const { subscription, secret } = await svc.create({
      url: 'https://hooks.example.com/all',
      events: ['*'],
      secret: 'whsec_byo_supplied',
    });
    expect(secret).toBe('whsec_byo_supplied');
    expect(subscription.events).toEqual(['*']);
  });

  test('rejects a bad url, empty events, or an unknown selector', async () => {
    await expect(svc.create({ url: 'not-a-url', events: ['lead.created'] })).rejects.toBeInstanceOf(
      WebhookValidationError,
    );
    await expect(svc.create({ url: 'https://x.test', events: [] })).rejects.toBeInstanceOf(
      WebhookValidationError,
    );
    await expect(
      svc.create({ url: 'https://x.test', events: ['lead.exploded'] }),
    ).rejects.toBeInstanceOf(WebhookValidationError);
  });
});

describe('get / list', () => {
  test('get 404s for a missing id; list is keyset + secret-free', async () => {
    await expect(svc.get('00000000-0000-4000-8000-0000000000cc')).rejects.toBeInstanceOf(
      WebhookSubscriptionNotFoundError,
    );

    for (let i = 0; i < 3; i += 1) {
      await svc.create({ url: `https://h.test/${i}`, events: ['lead.created'] });
    }
    const page1 = await svc.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
    for (const item of page1.items) expect(item).not.toHaveProperty('secret');

    const page2 = await svc.list({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
  });
});

describe('update / rotate', () => {
  test('update changes url/events/active', async () => {
    const { subscription } = await svc.create({
      url: 'https://h.test/a',
      events: ['lead.created'],
    });
    const updated = await svc.update(subscription.id, {
      url: 'https://h.test/b',
      events: ['opportunity.created', 'activity.recorded'],
      isActive: false,
    });
    expect(updated.url).toBe('https://h.test/b');
    expect(updated.events).toEqual(['opportunity.created', 'activity.recorded']);
    expect(updated.isActive).toBe(false);
  });

  test('rotateSecret issues a new secret and changes the stored value', async () => {
    const created = await svc.create({ url: 'https://h.test/a', events: ['lead.created'] });
    const rotated = await svc.rotateSecret(created.subscription.id);
    expect(rotated.secret).not.toBe(created.secret);
    const stored = await ctx.db
      .select({ secret: webhookSubscriptions.secret })
      .from(webhookSubscriptions)
      .where(sql`${webhookSubscriptions.id} = ${created.subscription.id}`);
    expect(stored[0]!.secret).toBe(rotated.secret);
  });

  test('update of a missing id → NotFound', async () => {
    await expect(
      svc.update('00000000-0000-4000-8000-0000000000dd', { isActive: false }),
    ).rejects.toBeInstanceOf(WebhookSubscriptionNotFoundError);
  });
});

describe('remove', () => {
  test('hard-deletes when there is no delivery history', async () => {
    const { subscription } = await svc.create({
      url: 'https://h.test/a',
      events: ['lead.created'],
    });
    await svc.remove(subscription.id);
    await expect(svc.get(subscription.id)).rejects.toBeInstanceOf(WebhookSubscriptionNotFoundError);
  });

  test('refuses to delete a subscription with delivery history (deactivate instead)', async () => {
    const { subscription } = await svc.create({
      url: 'https://h.test/a',
      events: ['lead.created'],
    });
    await ctx.db.insert(webhookDeliveries).values({
      subscriptionId: subscription.id,
      event: { id: 'e1', type: 'lead.created', data: {} },
      state: 'delivered',
      attempts: 1,
    });
    await expect(svc.remove(subscription.id)).rejects.toBeInstanceOf(WebhookHasDeliveriesError);
  });
});
