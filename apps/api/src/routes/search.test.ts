import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../server.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';

/**
 * Task 1e — REST search route (`GET /api/v1/search`, CONTRACTS §C7/§C8).
 * Drives the route through `fastify.inject` against a real (PGlite) DB wired via
 * `buildServer({ db })`: the success envelope `{ items, nextCursor? }`,
 * pagination, and the `VALIDATION_FAILED` failure paths.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const L_ACME = '11111111-0000-4000-8000-000000000001';

let ctx: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`
    INSERT INTO users (id, email, name, role, idp_subject) VALUES
      ('${USER}', 'u@example.com', 'Rep One', 'rep', 'idp|u');
    INSERT INTO leads (id, name, url, owner_id) VALUES
      ('${L_ACME}', 'Acme', 'https://acme.example.com', '${USER}'),
      ('11111111-0000-4000-8000-000000000002', 'Acme Corporation', 'https://acmecorp.io', '${USER}');
    INSERT INTO contacts (id, lead_id, name, emails) VALUES
      ('22222222-0000-4000-8000-000000000001', '${L_ACME}', 'Acme Alice',
        '[{"email":"alice@acme.example.com","type":"work"}]');
  `);
  app = buildServer({ db: ctx.db });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('GET /api/v1/search — success', () => {
  test('returns the { items, nextCursor? } envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=Acme' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: unknown[]; nextCursor?: string }>();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    const first = body.items[0] as Record<string, unknown>;
    expect(first).toHaveProperty('type');
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('leadId');
    expect(first).toHaveProperty('title');
    expect(first).toHaveProperty('subtitle');
    expect(first).toHaveProperty('rank');
    // Exact-name lead ranks first.
    expect(first['id']).toBe(L_ACME);
  });

  test('paginates via limit + nextCursor', async () => {
    const p1 = await app.inject({ method: 'GET', url: '/api/v1/search?q=Acme&limit=1' });
    expect(p1.statusCode).toBe(200);
    const b1 = p1.json<{ items: { id: string }[]; nextCursor?: string }>();
    expect(b1.items).toHaveLength(1);
    expect(typeof b1.nextCursor).toBe('string');

    const p2 = await app.inject({
      method: 'GET',
      url: `/api/v1/search?q=Acme&limit=1&cursor=${encodeURIComponent(b1.nextCursor ?? '')}`,
    });
    expect(p2.statusCode).toBe(200);
    const b2 = p2.json<{ items: { id: string }[] }>();
    expect(b2.items).toHaveLength(1);
    expect(b2.items[0]?.id).not.toBe(b1.items[0]?.id);
  });

  test('empty q returns an empty page (not an error)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  test('missing q defaults to an empty page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });
});

describe('GET /api/v1/search — validation (C8)', () => {
  const badLimits = ['0', '-1', '999', 'abc', '1.5'];
  test.each(badLimits)('limit=%s → 400 VALIDATION_FAILED', async (limit) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/search?q=Acme&limit=${limit}` });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(typeof body.error.message).toBe('string');
  });

  test('malformed cursor → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=Acme&cursor=not-a-valid-cursor!!',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});
