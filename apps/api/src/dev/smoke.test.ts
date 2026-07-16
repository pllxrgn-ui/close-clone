import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { buildDevServer, type DevServer } from './boot.ts';

/**
 * Dev-server smoke test (the demo's safety net). Boots the whole thing
 * programmatically on embedded PGlite + the golden fixture, then walks the
 * demo-critical path — dev-login → smart-views → preview → lead timeline →
 * search — asserting C7 envelopes, 200s, and the failure paths (401/404/400).
 *
 * The full 5k golden load dominates boot (tens of seconds under load), so the
 * boot hook carries a generous timeout, matching the golden suite.
 */

const BOOT_TIMEOUT = 300_000;

let server: DevServer;

beforeAll(async () => {
  server = await buildDevServer();
}, BOOT_TIMEOUT);

afterAll(async () => {
  await server.close();
});

interface InjectResult {
  status: number;
  body: unknown;
  headers: Record<string, unknown>;
}

async function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'OPTIONS',
  url: string,
  opts: {
    payload?: unknown;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<InjectResult> {
  const res = await server.app.inject({
    method,
    url,
    ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
    ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
  });
  let body: unknown = undefined;
  if (res.body.length > 0) {
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
  }
  return { status: res.statusCode, body, headers: res.headers };
}

function expectC7Error(body: unknown, code: string): void {
  expect(body).toMatchObject({ error: { code, message: expect.any(String) } });
}

function expectKeysetPage(
  body: unknown,
): asserts body is { items: unknown[]; nextCursor?: string } {
  expect(body).not.toBeNull();
  expect(Array.isArray((body as { items?: unknown }).items)).toBe(true);
}

describe('dev-server boot', () => {
  test('cold start loads the full golden fixture within budget', () => {
    expect(server.counts).not.toBeNull();
    expect(server.counts?.leads).toBe(5000);
    expect(server.counts?.activities).toBe(62792);
    // ≤ ~60s budget (acceptance). Generous ceiling to absorb CI/host contention.
    expect(server.timings.totalMs).toBeLessThan(90_000);
  });

  test('GET /healthz is a liveness probe', async () => {
    const res = await inject('GET', '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, checks: { db: 'up' } });
  });

  test('GET /api/v1/dev/ping reports mock mode + fixture counts', async () => {
    const res = await inject('GET', '/api/v1/dev/ping');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, mode: 'mock', fixtures: { leads: 5000 } });
  });

  test('CORS preflight is answered for the Vite origin', async () => {
    const res = await inject('OPTIONS', '/api/v1/leads', {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('dev-login', () => {
  test('dev-users → dev-login (cookie + bearer) → me', async () => {
    const usersRes = await inject('GET', '/api/v1/auth/dev-users');
    expect(usersRes.status).toBe(200);
    const users = usersRes.body as Array<{ id: string; name: string; email: string; role: string }>;
    expect(users.length).toBeGreaterThan(0);
    const user = users[0]!;
    expect(user).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      role: expect.any(String),
    });

    const loginRes = await inject('POST', '/api/v1/auth/dev-login', {
      payload: { userId: user.id },
    });
    expect(loginRes.status).toBe(200);
    const login = loginRes.body as { user: { id: string }; token: string };
    expect(login.user.id).toBe(user.id);
    expect(typeof login.token).toBe('string');
    const setCookie = String(loginRes.headers['set-cookie']);
    expect(setCookie).toContain('sb_dev_session=');

    const meRes = await inject('GET', '/api/v1/auth/me', {
      cookies: { sb_dev_session: login.token },
    });
    expect(meRes.status).toBe(200);
    expect((meRes.body as { id: string }).id).toBe(user.id);

    // Bearer works too.
    const meBearer = await inject('GET', '/api/v1/auth/me', {
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(meBearer.status).toBe(200);
  });

  test('GET /auth/me without a session is 401 (C7 envelope)', async () => {
    const res = await inject('GET', '/api/v1/auth/me');
    expect(res.status).toBe(401);
    expectC7Error(res.body, 'UNAUTHENTICATED');
  });

  test('dev-login with a bad body is 400', async () => {
    const res = await inject('POST', '/api/v1/auth/dev-login', {
      payload: { userId: 'not-a-uuid' },
    });
    expect(res.status).toBe(400);
    expectC7Error(res.body, 'VALIDATION_FAILED');
  });
});

describe('reference reads (C7 / D-023)', () => {
  test('GET /users returns the MINIMAL shape only (no idp/token fields)', async () => {
    const res = await inject('GET', '/api/v1/users');
    expect(res.status).toBe(200);
    const users = res.body as Array<Record<string, unknown>>;
    expect(users.length).toBeGreaterThan(0);
    const u = users[0]!;
    expect(Object.keys(u).sort()).toEqual(['email', 'id', 'isActive', 'name']);
    expect(u).not.toHaveProperty('idpSubject');
    expect(u).not.toHaveProperty('timezone');
    expect(u).not.toHaveProperty('role');
  });

  test('GET /lead-statuses and /opportunity-stages return sorted dimension rows', async () => {
    const statuses = await inject('GET', '/api/v1/lead-statuses');
    expect(statuses.status).toBe(200);
    const s = statuses.body as Array<{ label: string; sortOrder: number }>;
    expect(s.length).toBeGreaterThan(0);
    expect(s[0]).toMatchObject({ label: expect.any(String), sortOrder: expect.any(Number) });

    const stages = await inject('GET', '/api/v1/opportunity-stages');
    expect(stages.status).toBe(200);
    expect((stages.body as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('leads reads', () => {
  test('GET /leads is a keyset page of the C7 Lead shape (no search columns leak)', async () => {
    const res = await inject('GET', '/api/v1/leads?limit=3');
    expect(res.status).toBe(200);
    expectKeysetPage(res.body);
    const page = res.body as { items: Array<Record<string, unknown>>; nextCursor?: string };
    expect(page.items.length).toBe(3);
    expect(typeof page.nextCursor).toBe('string');
    const lead = page.items[0]!;
    expect(lead).not.toHaveProperty('searchTsv');
    expect(lead).not.toHaveProperty('searchText');
    // ISO-8601 timestamp (T…Z), matching the web's mock shape.
    expect(String(lead.createdAt)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test('keyset cursor advances the page', async () => {
    const first = await inject('GET', '/api/v1/leads?limit=2');
    const firstPage = first.body as { items: Array<{ id: string }>; nextCursor: string };
    const second = await inject(
      'GET',
      `/api/v1/leads?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    const secondPage = second.body as { items: Array<{ id: string }> };
    const firstIds = new Set(firstPage.items.map((l) => l.id));
    for (const l of secondPage.items) expect(firstIds.has(l.id)).toBe(false);
  });

  test('GET /leads/:id resolves; unknown id is 404', async () => {
    const list = await inject('GET', '/api/v1/leads?limit=1');
    const id = (list.body as { items: Array<{ id: string }> }).items[0]!.id;
    const one = await inject('GET', `/api/v1/leads/${id}`);
    expect(one.status).toBe(200);
    expect((one.body as { id: string }).id).toBe(id);

    const missing = await inject('GET', '/api/v1/leads/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expectC7Error(missing.body, 'NOT_FOUND');
  });

  test('GET /leads/:id/timeline is a newest-first Activity page', async () => {
    const list = await inject('GET', '/api/v1/leads?limit=1');
    const id = (list.body as { items: Array<{ id: string }> }).items[0]!.id;
    const tl = await inject('GET', `/api/v1/leads/${id}/timeline?limit=5`);
    expect(tl.status).toBe(200);
    expectKeysetPage(tl.body);
    const items = (tl.body as { items: Array<{ occurredAt: string }> }).items;
    // Non-increasing occurredAt (newest first).
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i - 1]!.occurredAt >= items[i]!.occurredAt).toBe(true);
    }

    const missing = await inject(
      'GET',
      '/api/v1/leads/00000000-0000-4000-8000-000000000000/timeline',
    );
    expect(missing.status).toBe(404);
    expectC7Error(missing.body, 'NOT_FOUND');
  });
});

describe('smart-views (CRUD-lite + compiler-backed preview)', () => {
  test('GET /smart-views lists the seeded demo views', async () => {
    const res = await inject('GET', '/api/v1/smart-views');
    expect(res.status).toBe(200);
    const views = res.body as Array<{ id: string; name: string; dsl: string; ast: unknown }>;
    expect(views.length).toBeGreaterThanOrEqual(7);
    const view = views[0]!;
    expect(view).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      dsl: expect.any(String),
    });
    expect(view.ast).not.toBeNull();
  });

  test('POST /smart-views/preview compiles + executes DSL (items + countEstimate)', async () => {
    const res = await inject('POST', '/api/v1/smart-views/preview', {
      payload: { dsl: 'name is_set', limit: 5 },
    });
    expect(res.status).toBe(200);
    const page = res.body as { items: unknown[]; countEstimate: number; nextCursor?: string };
    expect(page.items.length).toBe(5);
    // `name is_set` matches every non-deleted lead → the full fixture count.
    expect(page.countEstimate).toBe(5000);
    expect(typeof page.nextCursor).toBe('string');
  });

  test('preview binds `me` to the dev session', async () => {
    const users = (await inject('GET', '/api/v1/auth/dev-users')).body as Array<{ id: string }>;
    const login = (
      await inject('POST', '/api/v1/auth/dev-login', { payload: { userId: users[0]!.id } })
    ).body as { token: string };
    const res = await inject('POST', '/api/v1/smart-views/preview', {
      payload: { dsl: 'owner in (me)', limit: 3 },
      cookies: { sb_dev_session: login.token },
    });
    expect(res.status).toBe(200);
    const page = res.body as { items: unknown[]; countEstimate: number };
    // The signed-in owner owns some (but not all) leads.
    expect(page.countEstimate).toBeGreaterThan(0);
    expect(page.countEstimate).toBeLessThan(5000);
  });

  test('preview of invalid DSL is 400 with a position (C7/C8)', async () => {
    const res = await inject('POST', '/api/v1/smart-views/preview', {
      payload: { dsl: 'status = =' },
    });
    expect(res.status).toBe(400);
    expectC7Error(res.body, 'VALIDATION_FAILED');
    expect(res.body).toHaveProperty('error.details.position');
  });

  test('preview without dsl or ast is 400', async () => {
    const res = await inject('POST', '/api/v1/smart-views/preview', { payload: {} });
    expect(res.status).toBe(400);
    expectC7Error(res.body, 'VALIDATION_FAILED');
  });

  test('create → get → patch → delete round-trips', async () => {
    const created = await inject('POST', '/api/v1/smart-views', {
      payload: { name: 'Smoke view', dsl: 'dnc = true', shared: true },
    });
    expect(created.status).toBe(201);
    const view = created.body as { id: string; name: string; dsl: string };
    expect(view.name).toBe('Smoke view');

    const got = await inject('GET', `/api/v1/smart-views/${view.id}`);
    expect(got.status).toBe(200);

    const patched = await inject('PATCH', `/api/v1/smart-views/${view.id}`, {
      payload: { name: 'Smoke view 2', dsl: 'status = "Won"' },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { name: string }).name).toBe('Smoke view 2');

    const deleted = await inject('DELETE', `/api/v1/smart-views/${view.id}`);
    expect(deleted.status).toBe(204);

    const gone = await inject('GET', `/api/v1/smart-views/${view.id}`);
    expect(gone.status).toBe(404);
  });

  test('create with invalid DSL is 400', async () => {
    const res = await inject('POST', '/api/v1/smart-views', {
      payload: { name: 'bad', dsl: 'status = =' },
    });
    expect(res.status).toBe(400);
    expectC7Error(res.body, 'VALIDATION_FAILED');
  });
});

describe('global search (real FTS route)', () => {
  test('GET /search returns a C7 items envelope', async () => {
    const res = await inject('GET', '/api/v1/search?q=Systems');
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { items?: unknown }).items)).toBe(true);
  });

  test('short query yields an empty page (not an error)', async () => {
    const res = await inject('GET', '/api/v1/search?q=a');
    expect(res.status).toBe(200);
    expect((res.body as { items: unknown[] }).items).toEqual([]);
  });
});
