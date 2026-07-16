import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { leadStatuses, leads, users, type Db } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import type { RawQueryable } from '../services/smartviews/index.ts';
import { registerSmartViewRoutes } from './smart-views.ts';

/**
 * Task R3 — smart-view routes over `fastify.inject` against PGlite (D-003). Pins
 * the drop-in HTTP contract the web already calls: paths, request bodies, response
 * shapes (SmartView / { items, countEstimate, nextCursor? }), and the §C8 error
 * envelope for every failure path. The compiler-correctness of preview is proven
 * in the service suite; here we assert the wire.
 */

const USER = '00000000-0000-4000-8000-00000000000a';
const ST_WON = '22222222-0000-4000-8000-000000000001';

let ctx: TestDb;
let db: Db;
let app: FastifyInstance;

function post(url: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}
function patch(url: string, body: unknown) {
  return app.inject({
    method: 'PATCH',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);
  db = ctx.db;

  await db
    .insert(users)
    .values([
      { id: USER, email: 'a@example.com', name: 'Rep A', role: 'rep', idpSubject: 'idp|a' },
    ]);
  await db.insert(leadStatuses).values([{ id: ST_WON, label: 'Won', sortOrder: 0 }]);
  for (let i = 0; i < 3; i += 1) {
    await db.insert(leads).values({ name: `Won ${i}`, statusId: ST_WON, ownerId: USER });
  }

  app = Fastify({ logger: false });
  registerSmartViewRoutes(app, {
    db,
    client: ctx.client as unknown as RawQueryable,
    orgTimezone: 'UTC',
    defaultUserId: USER,
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('smart-views routes — CRUD wire', () => {
  test('POST creates (201), GET reads it, GET list includes it', async () => {
    const created = await post('/api/v1/smart-views', { name: 'Open', dsl: 'owner in (me)' });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; name: string; ownerId: string | null };
    expect(body.name).toBe('Open');
    expect(body.ownerId).toBe(USER);

    const read = await app.inject({ method: 'GET', url: `/api/v1/smart-views/${body.id}` });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { id: string }).id).toBe(body.id);

    const list = await app.inject({ method: 'GET', url: '/api/v1/smart-views' });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string }[]).some((v) => v.id === body.id)).toBe(true);
  });

  test('POST create with missing dsl → 400 VALIDATION_FAILED', async () => {
    const res = await post('/api/v1/smart-views', { name: 'x' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  test('POST create with an invalid dsl → 400 with a parse position', async () => {
    const res = await post('/api/v1/smart-views', { name: 'bad', dsl: 'status =' });
    expect(res.statusCode).toBe(400);
    const err = (res.json() as { error: { code: string; details?: { position?: unknown } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details?.position).toBeDefined();
  });

  test('GET /:id unknown → 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/smart-views/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  test('PATCH updates name + dsl (200); unknown id → 404', async () => {
    const created = await post('/api/v1/smart-views', { name: 'orig', dsl: 'dnc = true' });
    const id = (created.json() as { id: string }).id;
    const res = await patch(`/api/v1/smart-views/${id}`, { name: 'new', dsl: 'dnc = false' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string; dsl: string }).dsl).toBe('dnc = false');

    const missing = await patch(`/api/v1/smart-views/${randomUUID()}`, { name: 'z' });
    expect(missing.statusCode).toBe(404);
  });

  test('DELETE removes (204) then 404', async () => {
    const created = await post('/api/v1/smart-views', { name: 'temp', dsl: 'dnc = true' });
    const id = (created.json() as { id: string }).id;
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/smart-views/${id}` });
    expect(del.statusCode).toBe(204);
    const again = await app.inject({ method: 'DELETE', url: `/api/v1/smart-views/${id}` });
    expect(again.statusCode).toBe(404);
  });
});

describe('smart-views routes — preview wire', () => {
  test('POST preview returns { items, countEstimate }', async () => {
    const res = await post('/api/v1/smart-views/preview', { dsl: 'status = "Won"' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string }[]; countEstimate: number };
    expect(body.items).toHaveLength(3);
    expect(body.countEstimate).toBe(3);
  });

  test('POST preview with neither dsl nor ast → 400', async () => {
    const res = await post('/api/v1/smart-views/preview', {});
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  test('POST preview with an invalid dsl → 400', async () => {
    const res = await post('/api/v1/smart-views/preview', { dsl: 'status =' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });
});

describe('smart-views routes — production wiring (client derived from db.$client)', () => {
  test('preview works when no explicit RawQueryable is injected', async () => {
    // Proves the zero-wiring composition path: the orchestrator passes only `db`
    // and the factory derives the raw client from `db.$client` (PGlite / pg Pool).
    const derived = Fastify({ logger: false });
    registerSmartViewRoutes(derived, { db, orgTimezone: 'UTC', defaultUserId: USER });
    await derived.ready();
    try {
      const res = await derived.inject({
        method: 'POST',
        url: '/api/v1/smart-views/preview',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ dsl: 'status = "Won"' }),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { countEstimate: number }).countEstimate).toBe(3);
    } finally {
      await derived.close();
    }
  });
});
