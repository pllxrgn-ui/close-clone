import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { seedUser } from '../services/email/test-helpers.ts';

/**
 * Templates REST surface (CONTRACTS §C7/§C8, task 2d). Drives the routes through
 * `buildServer({ db })` + `fastify.inject`: CRUD, owner/shared visibility, and the
 * C8 failure codes (validation, not-found, forbidden). Proves the API honours the
 * same ownership rails as the engine.
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
  return app.inject({ method: 'POST', url: '/api/v1/templates', payload });
}

describe('CRUD', () => {
  test('create → 201, get → 200', async () => {
    const c = await create({ actorId: owner, name: 'Intro', channel: 'email', body: 'b' });
    expect(c.statusCode).toBe(201);
    const id = c.json<{ id: string }>().id;
    const g = await app.inject({ method: 'GET', url: `/api/v1/templates/${id}?actorId=${owner}` });
    expect(g.statusCode).toBe(200);
    expect(g.json<{ name: string }>().name).toBe('Intro');
  });

  test('invalid channel is 400', async () => {
    const res = await create({ actorId: owner, name: 'X', channel: 'carrier-pigeon', body: 'b' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  test('list returns own + shared { items }', async () => {
    await create({ actorId: owner, name: 'Mine', channel: 'email', body: 'b' });
    await create({
      actorId: other,
      name: 'OtherShared',
      channel: 'email',
      body: 'b',
      shared: true,
    });
    await create({ actorId: other, name: 'OtherPriv', channel: 'email', body: 'b' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/templates?actorId=${owner}` });
    expect(res.statusCode).toBe(200);
    const names = res
      .json<{ items: { name: string }[] }>()
      .items.map((t) => t.name)
      .sort();
    expect(names).toEqual(['Mine', 'OtherShared']);
  });
});

describe('visibility + ownership rails', () => {
  test("a non-owner cannot GET another rep's private template (404)", async () => {
    const id = (await create({ actorId: owner, name: 'Priv', channel: 'email', body: 'b' })).json<{
      id: string;
    }>().id;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/templates/${id}?actorId=${other}`,
    });
    expect(res.statusCode).toBe(404);
  });

  test('a non-owner PATCH of a shared template is 403 FORBIDDEN', async () => {
    const id = (
      await create({ actorId: owner, name: 'S', channel: 'email', body: 'b', shared: true })
    ).json<{ id: string }>().id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/templates/${id}`,
      payload: { actorId: other, name: 'hax' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
  });

  test('owner PATCH → 200; DELETE → 200 then GET 404', async () => {
    const id = (await create({ actorId: owner, name: 'D', channel: 'email', body: 'b' })).json<{
      id: string;
    }>().id;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/templates/${id}`,
      payload: { actorId: owner, name: 'D2' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ name: string }>().name).toBe('D2');
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/templates/${id}`,
      payload: { actorId: owner },
    });
    expect(del.statusCode).toBe(200);
    const g = await app.inject({ method: 'GET', url: `/api/v1/templates/${id}?actorId=${owner}` });
    expect(g.statusCode).toBe(404);
  });

  test('an unknown actor creating is 403', async () => {
    const res = await create({
      actorId: '00000000-0000-4000-8000-0000000000ff',
      name: 'X',
      channel: 'email',
      body: 'b',
    });
    expect(res.statusCode).toBe(403);
  });
});
