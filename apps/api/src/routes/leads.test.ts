import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { activities, leads } from '../db/index.ts';
import { registerLeadRoutes } from './leads.ts';

/**
 * Task R1 — real leads CRUD routes (CONTRACTS §C7 `leads` + timeline + merge,
 * §C8 errors, §C4 events). Drives the plugin through `fastify.inject` against a
 * real (PGlite) DB, and asserts the C4 events land on the append-only spine with
 * the exact payloads. A bare app (not `buildServer`) mounts only this plugin —
 * it is not yet wired into `registerRoutes` (that is the orchestrator's job at
 * merge; see routeWiring).
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const USER2 = '00000000-0000-4000-8000-0000000000bb';
const PAGER = '00000000-0000-4000-8000-0000000000cc';
const STATUS_NEW = '99999999-0000-4000-8000-000000000001';
const STATUS_QUAL = '99999999-0000-4000-8000-000000000002';

const L_READ = '11111111-0000-4000-8000-000000000001';
const L_DELETED = '11111111-0000-4000-8000-0000000000de';
const L_PATCH = '11111111-0000-4000-8000-0000000000a1';
const L_DNC = '11111111-0000-4000-8000-0000000000a2';
const L_DEL_TARGET = '11111111-0000-4000-8000-0000000000a3';
const L_TIMELINE = '11111111-0000-4000-8000-0000000000a4';
const L_WIN = '11111111-0000-4000-8000-0000000000b1';
const L_LOSE = '11111111-0000-4000-8000-0000000000b2';
const P1 = '11111111-0000-4000-8000-0000000000f1';
const P2 = '11111111-0000-4000-8000-0000000000f2';
const P3 = '11111111-0000-4000-8000-0000000000f3';

const A1 = '33333333-0000-4000-8000-000000000001';
const A2 = '33333333-0000-4000-8000-000000000002';
const A3 = '33333333-0000-4000-8000-000000000003';

let ctx: TestDb;
let app: FastifyInstance;

interface ErrBody {
  error: { code: string; message: string; details?: unknown };
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`
    INSERT INTO users (id, email, name, role, idp_subject) VALUES
      ('${USER}',  'u1@example.com', 'Rep One', 'rep', 'idp|u1'),
      ('${USER2}', 'u2@example.com', 'Rep Two', 'rep', 'idp|u2'),
      ('${PAGER}', 'u3@example.com', 'Pager',   'rep', 'idp|u3');
    INSERT INTO lead_statuses (id, label, sort_order) VALUES
      ('${STATUS_NEW}',  'Potential', 0),
      ('${STATUS_QUAL}', 'Qualified', 1);
    INSERT INTO leads (id, name, url, description, status_id, owner_id, dnc, created_at) VALUES
      ('${L_READ}',      'Acme',       'https://acme.example', 'maker of anvils', '${STATUS_NEW}',  '${USER}',  false, '2026-01-01T00:00:00Z'),
      ('${L_DELETED}',   'Ghost Co',   null, null, '${STATUS_NEW}',  '${USER}',  false, '2026-01-02T00:00:00Z'),
      ('${L_PATCH}',     'Patchable',  null, null, '${STATUS_NEW}',  '${USER}',  false, '2026-01-03T00:00:00Z'),
      ('${L_DNC}',       'DncTarget',  null, null, '${STATUS_NEW}',  '${USER}',  false, '2026-01-04T00:00:00Z'),
      ('${L_DEL_TARGET}','DeleteMe',   null, null, '${STATUS_NEW}',  '${USER}',  false, '2026-01-05T00:00:00Z'),
      ('${L_TIMELINE}',  'Timeline',   null, null, '${STATUS_NEW}',  '${USER}',  false, '2026-01-06T00:00:00Z'),
      ('${L_WIN}',       'Winner',     null, null, '${STATUS_NEW}',  '${USER}',  false, '2026-01-07T00:00:00Z'),
      ('${L_LOSE}',      'Loser',      null, null, '${STATUS_NEW}',  '${USER}',  true,  '2026-01-08T00:00:00Z'),
      ('${P1}', 'Pager One',   null, null, '${STATUS_QUAL}', '${PAGER}', false, '2026-05-01T00:00:00Z'),
      ('${P2}', 'Pager Two',   null, null, '${STATUS_QUAL}', '${PAGER}', false, '2026-05-02T00:00:00Z'),
      ('${P3}', 'Pager Three', null, null, '${STATUS_QUAL}', '${PAGER}', false, '2026-05-03T00:00:00Z');
    UPDATE leads SET deleted_at = now() WHERE id = '${L_DELETED}';
    INSERT INTO activities (id, lead_id, type, occurred_at, payload) VALUES
      ('${A1}', '${L_TIMELINE}', 'lead_created', '2026-06-01T00:00:00Z', '{}'),
      ('${A2}', '${L_TIMELINE}', 'note_added',   '2026-06-02T00:00:00Z', '{}'),
      ('${A3}', '${L_TIMELINE}', 'call_logged',  '2026-06-03T00:00:00Z', '{}');
  `);

  app = Fastify({ logger: false });
  registerLeadRoutes(app, { db: ctx.db });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

// ── GET /leads (list) ────────────────────────────────────────────────────────
describe('GET /api/v1/leads', () => {
  test('returns the { items, nextCursor? } envelope, newest-created first', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/leads?ownerId=${PAGER}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { id: string }[]; nextCursor?: string }>();
    expect(body.items.map((l) => l.id)).toEqual([P3, P2, P1]);
    expect(body.nextCursor).toBeUndefined();
  });

  test('filters by statusId', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/leads?statusId=${STATUS_QUAL}` });
    const body = res.json<{ items: { id: string }[] }>();
    expect(new Set(body.items.map((l) => l.id))).toEqual(new Set([P1, P2, P3]));
  });

  test('excludes soft-deleted leads', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/leads?ownerId=${USER}` });
    const ids = res.json<{ items: { id: string }[] }>().items.map((l) => l.id);
    expect(ids).not.toContain(L_DELETED);
  });

  test('the Lead DTO carries ISO timestamps and no search columns', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/leads?ownerId=${PAGER}&limit=1` });
    const first = res.json<{ items: Record<string, unknown>[] }>().items[0];
    expect(first).toBeDefined();
    expect(first).not.toHaveProperty('searchTsv');
    expect(first).not.toHaveProperty('searchText');
    expect(first?.['createdAt']).toMatch(/T.*Z$/);
    expect(first).toHaveProperty('dnc');
    expect(first).toHaveProperty('custom');
  });

  test('paginates via limit + nextCursor (keyset)', async () => {
    const p1 = await app.inject({ method: 'GET', url: `/api/v1/leads?ownerId=${PAGER}&limit=2` });
    const b1 = p1.json<{ items: { id: string }[]; nextCursor?: string }>();
    expect(b1.items.map((l) => l.id)).toEqual([P3, P2]);
    expect(typeof b1.nextCursor).toBe('string');

    const p2 = await app.inject({
      method: 'GET',
      url: `/api/v1/leads?ownerId=${PAGER}&limit=2&cursor=${encodeURIComponent(b1.nextCursor ?? '')}`,
    });
    const b2 = p2.json<{ items: { id: string }[]; nextCursor?: string }>();
    expect(b2.items.map((l) => l.id)).toEqual([P1]);
    expect(b2.nextCursor).toBeUndefined();
  });

  test('malformed cursor → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/leads?cursor=not-valid!!' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrBody>().error.code).toBe('VALIDATION_FAILED');
  });

  test.each(['0', '-1', '999', 'abc'])('limit=%s → 400 VALIDATION_FAILED', async (limit) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/leads?limit=${limit}` });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrBody>().error.code).toBe('VALIDATION_FAILED');
  });
});

// ── GET /leads/:id ───────────────────────────────────────────────────────────
describe('GET /api/v1/leads/:id', () => {
  test('returns the full Lead DTO', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/leads/${L_READ}` });
    expect(res.statusCode).toBe(200);
    const lead = res.json<{ id: string; name: string; url: string | null }>();
    expect(lead.id).toBe(L_READ);
    expect(lead.name).toBe('Acme');
    expect(lead.url).toBe('https://acme.example');
  });

  test('missing lead → 404 NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leads/11111111-0000-4000-8000-000000009999',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrBody>().error.code).toBe('NOT_FOUND');
  });

  test('soft-deleted lead → 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/leads/${L_DELETED}` });
    expect(res.statusCode).toBe(404);
  });
});

// ── POST /leads ──────────────────────────────────────────────────────────────
describe('POST /api/v1/leads', () => {
  test('creates a lead (201) and emits lead_created via the writer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      payload: { name: 'Newco', url: 'https://newco.example', statusId: STATUS_NEW, ownerId: USER },
    });
    expect(res.statusCode).toBe(201);
    const lead = res.json<{ id: string; name: string; dnc: boolean; custom: unknown }>();
    expect(lead.name).toBe('Newco');
    expect(lead.dnc).toBe(false);
    expect(lead.custom).toEqual({});

    const evs = await ctx.db
      .select({ type: activities.type })
      .from(activities)
      .where(eq(activities.leadId, lead.id));
    expect(evs.map((e) => e.type)).toEqual(['lead_created']);
  });

  test('missing name → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/leads', payload: { url: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrBody>().error.code).toBe('VALIDATION_FAILED');
  });

  test('unknown statusId reference → 400 VALIDATION_FAILED (no lead written)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      payload: { name: 'BadRef', statusId: '99999999-0000-4000-8000-000000000404' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrBody>().error.code).toBe('VALIDATION_FAILED');
    const rows = await ctx.db.select({ id: leads.id }).from(leads).where(eq(leads.name, 'BadRef'));
    expect(rows).toHaveLength(0);
  });
});

// ── PATCH /leads/:id ─────────────────────────────────────────────────────────
async function typesFor(leadId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ type: activities.type, createdAt: activities.createdAt })
    .from(activities)
    .where(eq(activities.leadId, leadId))
    .orderBy(asc(activities.createdAt));
  return rows.map((r) => r.type);
}

describe('PATCH /api/v1/leads/:id', () => {
  test('status change emits status_changed with {from,to}', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/leads/${L_PATCH}`,
      payload: { statusId: STATUS_QUAL },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ statusId: string }>().statusId).toBe(STATUS_QUAL);

    const ev = await ctx.db
      .select({ type: activities.type, payload: activities.payload })
      .from(activities)
      .where(and(eq(activities.leadId, L_PATCH), eq(activities.type, 'status_changed')));
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ from: STATUS_NEW, to: STATUS_QUAL });
  });

  test('name change emits field_changed with {field,before,after}', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/leads/${L_PATCH}`,
      payload: { name: 'Patched Inc' },
    });
    expect(res.statusCode).toBe(200);
    const ev = await ctx.db
      .select({ payload: activities.payload })
      .from(activities)
      .where(and(eq(activities.leadId, L_PATCH), eq(activities.type, 'field_changed')));
    expect(ev.at(-1)?.payload).toEqual({
      field: 'name',
      before: 'Patchable',
      after: 'Patched Inc',
    });
  });

  test('owner reassignment emits field_changed for ownerId', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/leads/${L_PATCH}`,
      payload: { ownerId: USER2 },
    });
    const ev = await ctx.db
      .select({ payload: activities.payload })
      .from(activities)
      .where(and(eq(activities.leadId, L_PATCH), eq(activities.type, 'field_changed')));
    expect(ev.map((e) => e.payload)).toContainEqual({
      field: 'ownerId',
      before: USER,
      after: USER2,
    });
  });

  test('a no-op change (same value) emits no event', async () => {
    const before = await typesFor(L_PATCH);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/leads/${L_PATCH}`,
      payload: { statusId: STATUS_QUAL }, // already QUAL from the first test
    });
    expect(res.statusCode).toBe(200);
    expect(await typesFor(L_PATCH)).toEqual(before);
  });

  test('DNC set emits dnc_set (scope lead) and updates the column', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/leads/${L_DNC}`,
      payload: { dnc: true, reason: 'customer asked' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ dnc: boolean }>().dnc).toBe(true);
    const ev = await ctx.db
      .select({ payload: activities.payload })
      .from(activities)
      .where(and(eq(activities.leadId, L_DNC), eq(activities.type, 'dnc_set')));
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ scope: 'lead', reason: 'customer asked' });
  });

  test('DNC clear emits dnc_cleared', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/leads/${L_DNC}`,
      payload: { dnc: false, reason: 'mistake' },
    });
    const ev = await ctx.db
      .select({ type: activities.type })
      .from(activities)
      .where(and(eq(activities.leadId, L_DNC), eq(activities.type, 'dnc_cleared')));
    expect(ev).toHaveLength(1);
  });

  test('empty patch (no mutating field) → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/leads/${L_PATCH}`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrBody>().error.code).toBe('VALIDATION_FAILED');
  });

  test('bare reason (no field) → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/leads/${L_PATCH}`,
      payload: { reason: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('unknown ownerId reference → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/leads/${L_PATCH}`,
      payload: { ownerId: '00000000-0000-4000-8000-000000000404' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrBody>().error.code).toBe('VALIDATION_FAILED');
  });

  test('missing lead → 404 NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/leads/11111111-0000-4000-8000-000000009999',
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── DELETE /leads/:id ────────────────────────────────────────────────────────
describe('DELETE /api/v1/leads/:id', () => {
  test('soft-deletes (204) and removes the lead from reads', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/leads/${L_DEL_TARGET}` });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({ method: 'GET', url: `/api/v1/leads/${L_DEL_TARGET}` });
    expect(get.statusCode).toBe(404);
  });

  test('deleting an already-deleted lead → 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/leads/${L_DEL_TARGET}` });
    expect(res.statusCode).toBe(404);
  });
});

// ── GET /leads/:id/timeline ──────────────────────────────────────────────────
describe('GET /api/v1/leads/:id/timeline', () => {
  test('returns activities newest-first and paginates by keyset', async () => {
    const p1 = await app.inject({
      method: 'GET',
      url: `/api/v1/leads/${L_TIMELINE}/timeline?limit=2`,
    });
    expect(p1.statusCode).toBe(200);
    const b1 = p1.json<{ items: { id: string }[]; nextCursor?: string }>();
    expect(b1.items.map((a) => a.id)).toEqual([A3, A2]);
    expect(typeof b1.nextCursor).toBe('string');

    const p2 = await app.inject({
      method: 'GET',
      url: `/api/v1/leads/${L_TIMELINE}/timeline?limit=2&cursor=${encodeURIComponent(b1.nextCursor ?? '')}`,
    });
    const b2 = p2.json<{ items: { id: string }[] }>();
    expect(b2.items.map((a) => a.id)).toEqual([A1]);
  });

  test('missing lead → 404 NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leads/11111111-0000-4000-8000-000000009999/timeline',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── POST /leads/merge ────────────────────────────────────────────────────────
describe('POST /api/v1/leads/merge', () => {
  test('merges loser into winner, soft-deletes loser, emits lead_merged', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads/merge',
      payload: { winnerId: L_WIN, loserId: L_LOSE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ winnerId: string; loserId: string; activityId: string }>();
    expect(body.winnerId).toBe(L_WIN);
    expect(body.loserId).toBe(L_LOSE);

    // Loser is gone from reads; winner absorbed the loser's DNC.
    const loser = await app.inject({ method: 'GET', url: `/api/v1/leads/${L_LOSE}` });
    expect(loser.statusCode).toBe(404);
    const winner = await app.inject({ method: 'GET', url: `/api/v1/leads/${L_WIN}` });
    expect(winner.json<{ dnc: boolean }>().dnc).toBe(true);

    const merged = await ctx.db
      .select({ type: activities.type })
      .from(activities)
      .where(and(eq(activities.leadId, L_WIN), eq(activities.type, 'lead_merged')));
    expect(merged).toHaveLength(1);
  });

  test('merging a lead into itself → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads/merge',
      payload: { winnerId: L_READ, loserId: L_READ },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrBody>().error.code).toBe('VALIDATION_FAILED');
  });

  test('merging a missing lead → 404 NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads/merge',
      payload: { winnerId: L_READ, loserId: '11111111-0000-4000-8000-000000009999' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrBody>().error.code).toBe('NOT_FOUND');
  });
});
