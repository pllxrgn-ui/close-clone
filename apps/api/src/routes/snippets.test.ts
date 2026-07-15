import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { seedUser } from '../services/email/test-helpers.ts';

/**
 * Snippets REST surface (CONTRACTS §C7/§C8, task 2d). Personal (owner-scoped) CRUD
 * over `buildServer({ db })` — a non-owner never sees another rep's snippet.
 */

let ctx: TestDb;
let app: FastifyInstance;
let owner: string;
let other: string;

beforeEach(async () => {
  ctx = await createTestDb();
  owner = await seedUser(ctx.db, { email: 'owner@example.com' });
  other = await seedUser(ctx.db, { email: 'other@example.com' });
  app = buildServer({ db: ctx.db });
  await app.ready();
}, 120_000);

afterEach(async () => {
  await app.close();
  await ctx.close();
});

async function create(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/snippets', payload });
}

test('create → 201, list scoped to owner', async () => {
  const c = await create({ actorId: owner, shortcut: ';sig', body: 'Best' });
  expect(c.statusCode).toBe(201);
  await create({ actorId: other, shortcut: ';x', body: 'y' });
  const res = await app.inject({ method: 'GET', url: `/api/v1/snippets?actorId=${owner}` });
  expect(res.statusCode).toBe(200);
  const shortcuts = res.json<{ items: { shortcut: string }[] }>().items.map((s) => s.shortcut);
  expect(shortcuts).toEqual([';sig']);
});

test("a non-owner cannot GET/PATCH/DELETE another rep's snippet (404)", async () => {
  const id = (await create({ actorId: owner, shortcut: ';sig', body: 'x' })).json<{ id: string }>()
    .id;
  expect(
    (await app.inject({ method: 'GET', url: `/api/v1/snippets/${id}?actorId=${other}` }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/snippets/${id}`,
        payload: { actorId: other, body: 'z' },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/snippets/${id}`,
        payload: { actorId: other },
      })
    ).statusCode,
  ).toBe(404);
});

test('owner PATCH → 200, DELETE → 200', async () => {
  const id = (await create({ actorId: owner, shortcut: ';sig', body: 'x' })).json<{ id: string }>()
    .id;
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/v1/snippets/${id}`,
    payload: { actorId: owner, body: 'z' },
  });
  expect(patch.statusCode).toBe(200);
  expect(patch.json<{ body: string }>().body).toBe('z');
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/v1/snippets/${id}`,
    payload: { actorId: owner },
  });
  expect(del.statusCode).toBe(200);
});
