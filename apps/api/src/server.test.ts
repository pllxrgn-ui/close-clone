import { afterAll, beforeAll, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.ts';

let app: FastifyInstance;

beforeAll(() => {
  app = buildServer();
});

afterAll(async () => {
  await app.close();
});

test('GET /healthz returns { ok: true, checks: {} }', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, checks: {} });
});
