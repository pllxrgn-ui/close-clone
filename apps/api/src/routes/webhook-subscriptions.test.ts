import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { sql } from 'drizzle-orm';

import { webhookDeliveries } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { registerWebhookSubscriptionRoutes } from './webhook-subscriptions.ts';

/**
 * Task 5c — `/api/v1/admin/webhook-subscriptions` (admin RBAC). Secret returned
 * once on create/rotate and never on read; CRUD + the delete-vs-ledger 409.
 */

const BASE = '/api/v1/admin/webhook-subscriptions';

const allowGuard: preHandlerHookHandler = async () => {};
const denyGuard: preHandlerHookHandler = async (_request, reply) =>
  reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'admin required' } });

let ctx: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestDb();
  app = Fastify({ logger: false });
  registerWebhookSubscriptionRoutes(app, { db: ctx.db, adminGuard: allowGuard });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM webhook_deliveries`);
  await ctx.db.execute(sql`DELETE FROM webhook_subscriptions`);
});

async function createSub(events: string[] = ['lead.created']): Promise<{ id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: BASE,
    payload: { url: 'https://h.test/hook', events },
  });
  return { id: res.json().subscription.id };
}

describe('admin guard', () => {
  test('deny → 403', async () => {
    const denyApp = Fastify({ logger: false });
    registerWebhookSubscriptionRoutes(denyApp, { db: ctx.db, adminGuard: denyGuard });
    await denyApp.ready();
    const res = await denyApp.inject({ method: 'GET', url: BASE });
    expect(res.statusCode).toBe(403);
    await denyApp.close();
  });
});

describe('create', () => {
  test('201 returns the secret once; the view omits it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { url: 'https://h.test/hook', events: ['lead.created', '*'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.subscription).not.toHaveProperty('secret');
    expect(body.subscription.events).toContain('*');
  });

  test('an unknown event selector → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { url: 'https://h.test/hook', events: ['lead.exploded'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  test('an empty events array → 400 (zod)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { url: 'https://h.test/hook', events: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('read / list never leak the secret', () => {
  test('list + get are secret-free', async () => {
    await createSub();
    const list = await app.inject({ method: 'GET', url: BASE });
    expect(list.statusCode).toBe(200);
    expect(list.payload).not.toContain('secret');
    expect(list.payload).not.toContain('whsec_');

    const id = list.json().items[0].id;
    const get = await app.inject({ method: 'GET', url: `${BASE}/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json()).not.toHaveProperty('secret');
  });

  test('get of a missing id → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/00000000-0000-4000-8000-0000000000cc`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('update / rotate', () => {
  test('PATCH updates fields; rotate-secret returns a fresh secret', async () => {
    const { id } = await createSub();
    const patch = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${id}`,
      payload: { isActive: false, events: ['opportunity.closed'] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().isActive).toBe(false);
    expect(patch.json().events).toEqual(['opportunity.closed']);

    const rotate = await app.inject({ method: 'POST', url: `${BASE}/${id}/rotate-secret` });
    expect(rotate.statusCode).toBe(200);
    expect(rotate.json().secret).toMatch(/^whsec_/);
  });

  test('an empty PATCH body → 400', async () => {
    const { id } = await createSub();
    const res = await app.inject({ method: 'PATCH', url: `${BASE}/${id}`, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('delete', () => {
  test('204 when there is no delivery history', async () => {
    const { id } = await createSub();
    const res = await app.inject({ method: 'DELETE', url: `${BASE}/${id}` });
    expect(res.statusCode).toBe(204);
  });

  test('409 when delivery history references the subscription', async () => {
    const { id } = await createSub();
    await ctx.db.insert(webhookDeliveries).values({
      subscriptionId: id,
      event: { id: 'e1', type: 'lead.created', data: {} },
      state: 'delivered',
      attempts: 1,
    });
    const res = await app.inject({ method: 'DELETE', url: `${BASE}/${id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });
});
