import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { activities } from '../db/index.ts';
import { registerContactRoutes } from './contacts.ts';

/**
 * Task R1 — real contacts CRUD routes (CONTRACTS §C7 `contacts`, §C8 errors).
 * Drives the plugin through `fastify.inject` against a real (PGlite) DB. Asserts
 * the WEB shape (plain array for the per-lead list) and the compliance rule:
 * plain contact edits emit no spine event, a DNC toggle emits a contact-scoped
 * `dnc_set`/`dnc_cleared` through the ActivityWriter.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const LEAD = '11111111-0000-4000-8000-000000000001';
const LEAD_DELETED = '11111111-0000-4000-8000-0000000000de';

const C_READ1 = '22222222-0000-4000-8000-000000000001';
const C_READ2 = '22222222-0000-4000-8000-000000000002';
const C_DELETED = '22222222-0000-4000-8000-0000000000de';
const C_PATCH = '22222222-0000-4000-8000-0000000000a1';
const C_DNC = '22222222-0000-4000-8000-0000000000a2';
const C_DEL = '22222222-0000-4000-8000-0000000000a3';

let ctx: TestDb;
let app: FastifyInstance;

interface ErrBody {
  error: { code: string; message: string };
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`
    INSERT INTO users (id, email, name, role, idp_subject) VALUES
      ('${USER}', 'u@example.com', 'Rep', 'rep', 'idp|u');
    INSERT INTO leads (id, name, owner_id) VALUES
      ('${LEAD}',         'Acme', '${USER}'),
      ('${LEAD_DELETED}', 'Dead', '${USER}');
    UPDATE leads SET deleted_at = now() WHERE id = '${LEAD_DELETED}';
    INSERT INTO contacts (id, lead_id, name, title, emails, created_at) VALUES
      ('${C_READ1}', '${LEAD}', 'Alice', 'CEO',
        '[{"email":"alice@acme.example","type":"work"}]', '2026-01-01T00:00:00Z'),
      ('${C_READ2}', '${LEAD}', 'Bob', 'CTO', '[]', '2026-01-02T00:00:00Z'),
      ('${C_DELETED}', '${LEAD}', 'Ghost', null, '[]', '2026-01-03T00:00:00Z'),
      ('${C_PATCH}', '${LEAD}', 'Patchy', null, '[]', '2026-01-04T00:00:00Z'),
      ('${C_DNC}', '${LEAD}', 'DncGuy', null, '[]', '2026-01-05T00:00:00Z'),
      ('${C_DEL}', '${LEAD}', 'DeleteMe', null, '[]', '2026-01-06T00:00:00Z');
    UPDATE contacts SET deleted_at = now() WHERE id = '${C_DELETED}';
  `);

  app = Fastify({ logger: false });
  registerContactRoutes(app, { db: ctx.db });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

// ── GET /contacts?leadId= ────────────────────────────────────────────────────
describe('GET /api/v1/contacts', () => {
  test('returns a PLAIN ARRAY of a lead contacts, oldest-first, live only', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/contacts?leadId=${LEAD}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<unknown>();
    expect(Array.isArray(body)).toBe(true);
    const rows = body as { id: string }[];
    const ids = rows.map((c) => c.id);
    expect(ids).not.toContain(C_DELETED);
    expect(ids.indexOf(C_READ1)).toBeLessThan(ids.indexOf(C_READ2));
  });

  test('Contact DTO carries emails/phones + no search columns', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/contacts?leadId=${LEAD}` });
    const first = res.json<Record<string, unknown>[]>().find((c) => c['id'] === C_READ1);
    expect(first?.['emails']).toEqual([{ email: 'alice@acme.example', type: 'work' }]);
    expect(first?.['phones']).toEqual([]);
    expect(first).not.toHaveProperty('searchTsv');
    expect(first).not.toHaveProperty('searchText');
  });

  test('missing leadId → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/contacts' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrBody>().error.code).toBe('VALIDATION_FAILED');
  });
});

// ── GET /contacts/:id ────────────────────────────────────────────────────────
describe('GET /api/v1/contacts/:id', () => {
  test('returns the Contact DTO', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/contacts/${C_READ1}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ name: string }>().name).toBe('Alice');
  });

  test('missing contact → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts/22222222-0000-4000-8000-000000009999',
    });
    expect(res.statusCode).toBe(404);
  });

  test('soft-deleted contact → 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/contacts/${C_DELETED}` });
    expect(res.statusCode).toBe(404);
  });

  test('malformed (non-uuid) id → 404 (never a 500)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/contacts/not-a-uuid' });
    expect(res.statusCode).toBe(404);
  });
});

// ── POST /contacts ───────────────────────────────────────────────────────────
describe('POST /api/v1/contacts', () => {
  test('creates a contact (201) under a live lead', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      payload: {
        leadId: LEAD,
        name: 'Carol',
        title: 'VP',
        emails: [{ email: 'carol@acme.example', type: 'work' }],
      },
    });
    expect(res.statusCode).toBe(201);
    const c = res.json<{ id: string; leadId: string; dnc: boolean }>();
    expect(c.leadId).toBe(LEAD);
    expect(c.dnc).toBe(false);
  });

  test('missing name → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      payload: { leadId: LEAD },
    });
    expect(res.statusCode).toBe(400);
  });

  test('unknown leadId → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      payload: { leadId: '11111111-0000-4000-8000-000000009999', name: 'Nobody' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrBody>().error.code).toBe('VALIDATION_FAILED');
  });

  test('creating under a soft-deleted lead → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      payload: { leadId: LEAD_DELETED, name: 'Zombie' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── PATCH /contacts/:id ──────────────────────────────────────────────────────
async function contactEventCount(contactId: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: activities.id })
    .from(activities)
    .where(eq(activities.contactId, contactId));
  return rows.length;
}

describe('PATCH /api/v1/contacts/:id', () => {
  test('a plain field edit updates the row and emits NO spine event', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/contacts/${C_PATCH}`,
      payload: { name: 'Patchy Renamed', title: 'Director' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ name: string; title: string }>().name).toBe('Patchy Renamed');
    expect(await contactEventCount(C_PATCH)).toBe(0);
  });

  test('DNC set emits a contact-scoped dnc_set on the lead timeline', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/contacts/${C_DNC}`,
      payload: { dnc: true, reason: 'opted out' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ dnc: boolean }>().dnc).toBe(true);

    const ev = await ctx.db
      .select({ leadId: activities.leadId, payload: activities.payload })
      .from(activities)
      .where(and(eq(activities.contactId, C_DNC), eq(activities.type, 'dnc_set')));
    expect(ev).toHaveLength(1);
    expect(ev[0]?.leadId).toBe(LEAD);
    expect(ev[0]?.payload).toMatchObject({
      scope: 'contact',
      contactId: C_DNC,
      reason: 'opted out',
    });
  });

  test('DNC clear emits dnc_cleared', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/contacts/${C_DNC}`,
      payload: { dnc: false },
    });
    const ev = await ctx.db
      .select({ type: activities.type })
      .from(activities)
      .where(and(eq(activities.contactId, C_DNC), eq(activities.type, 'dnc_cleared')));
    expect(ev).toHaveLength(1);
  });

  test('empty patch → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/contacts/${C_PATCH}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  test('missing contact → 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/contacts/22222222-0000-4000-8000-000000009999',
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── DELETE /contacts/:id ─────────────────────────────────────────────────────
describe('DELETE /api/v1/contacts/:id', () => {
  test('soft-deletes (204) and removes the contact from reads', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/contacts/${C_DEL}` });
    expect(del.statusCode).toBe(204);
    const get = await app.inject({ method: 'GET', url: `/api/v1/contacts/${C_DEL}` });
    expect(get.statusCode).toBe(404);
  });

  test('already-deleted contact → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/contacts/${C_DEL}` });
    expect(res.statusCode).toBe(404);
  });
});
