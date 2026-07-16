import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { opportunitySchema, type ActivityType } from '@switchboard/shared';

import {
  activities,
  contacts,
  leads,
  opportunities,
  opportunityStages,
  users,
  type ActivityRow,
} from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { registerOpportunitiesRoutes } from './opportunities.ts';

/**
 * Opportunities CRUD routes (CONTRACTS §C7 `opportunities`, §C4 events, §C8
 * errors). Drives the plugin through `fastify.inject` against PGlite. Asserts the
 * dual GET shape (board keyset envelope vs per-lead plain array), the C4 event
 * emission on POST/PATCH (stage move + won/lost close), the ISO-normalized DTO,
 * and the C8 failure paths.
 */

const USER = '00000000-0000-4000-8000-0000000000a1';
const LEAD = '11111111-0000-4000-8000-000000000001';
const LEAD2 = '11111111-0000-4000-8000-000000000002';
const CONTACT = '66666666-0000-4000-8000-000000000001';
const STAGE_A = '22222222-0000-4000-8000-0000000000a1';
const STAGE_B = '22222222-0000-4000-8000-0000000000b1';
const STAGE_WON = '22222222-0000-4000-8000-0000000000c1';
const MISSING = '99999999-0000-4000-8000-000000000999';

let ctx: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);

  await ctx.db
    .insert(users)
    .values([
      { id: USER, email: 'rep@example.com', name: 'Rep', role: 'rep', idpSubject: 'idp|a' },
    ]);
  await ctx.db.insert(leads).values([
    { id: LEAD, name: 'Acme', ownerId: USER },
    { id: LEAD2, name: 'Globex', ownerId: USER },
  ]);
  await ctx.db.insert(contacts).values([{ id: CONTACT, leadId: LEAD, name: 'Contact' }]);
  await ctx.db.insert(opportunityStages).values([
    { id: STAGE_A, label: 'Discovery', sortOrder: 0 },
    { id: STAGE_B, label: 'Proposal', sortOrder: 1 },
    { id: STAGE_WON, label: 'Closed Won', sortOrder: 2 },
  ]);

  app = Fastify({ logger: false });
  registerOpportunitiesRoutes(app, { db: ctx.db });
  await app.ready();
}, 120_000);

beforeEach(async () => {
  await ctx.db.delete(activities);
  await ctx.db.delete(opportunities);
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

/** All activities for a lead of a given type, ordered by occurrence. */
async function eventsOfType(leadId: string, type: ActivityType): Promise<ActivityRow[]> {
  return ctx.db
    .select()
    .from(activities)
    .where(and(eq(activities.leadId, leadId), eq(activities.type, type)));
}

async function createOpp(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/opportunities', payload: body });
  expect(res.statusCode).toBe(201);
  return res.json<Record<string, unknown>>();
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('POST /api/v1/opportunities', () => {
  test('creates an opportunity, returns 201 + ISO DTO, emits opportunity_created', async () => {
    const opp = await createOpp({
      leadId: LEAD,
      contactId: CONTACT,
      valueCents: 500000,
      currency: 'USD',
      stageId: STAGE_A,
      confidence: 40,
      closeDate: '2026-09-01',
      ownerId: USER,
      status: 'active',
      note: 'inbound',
      actorId: USER,
    });
    expect(opp.valueCents).toBe(500000);
    expect(opp.currency).toBe('USD');
    expect(opp.stageId).toBe(STAGE_A);
    expect(opp.closeDate).toBe('2026-09-01');
    expect(opp.status).toBe('active');
    expect(typeof opp.id).toBe('string');
    expect(opp.createdAt).toMatch(ISO_RE);
    expect(opp.updatedAt).toMatch(ISO_RE);

    const created = await eventsOfType(LEAD, 'opportunity_created');
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({ opportunityId: opp.id, valueCents: 500000 });
    expect(created[0]?.userId).toBe(USER);
  });

  test('defaults valueCents=0, currency=USD, status=active, confidence=0', async () => {
    const opp = await createOpp({ leadId: LEAD });
    expect(opp.valueCents).toBe(0);
    expect(opp.currency).toBe('USD');
    expect(opp.status).toBe('active');
    expect(opp.confidence).toBe(0);
    expect(opp.stageId).toBeNull();
  });

  test('unknown leadId → 404 NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { leadId: MISSING },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  test('unknown stageId → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { leadId: LEAD, stageId: MISSING },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    // The invalid reference must not have created a row or an event.
    expect(await eventsOfType(LEAD, 'opportunity_created')).toHaveLength(0);
  });

  test('missing leadId → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { valueCents: 100 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/opportunities', () => {
  test('no leadId → keyset envelope { items, nextCursor? }, paginates', async () => {
    await createOpp({ leadId: LEAD, valueCents: 100 });
    await createOpp({ leadId: LEAD, valueCents: 200 });
    await createOpp({ leadId: LEAD2, valueCents: 300 });

    const first = await app.inject({ method: 'GET', url: '/api/v1/opportunities?limit=2' });
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{ items: unknown[]; nextCursor?: string }>();
    expect(Array.isArray(page1.items)).toBe(true);
    expect(page1.items).toHaveLength(2);
    expect(typeof page1.nextCursor).toBe('string');

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/opportunities?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
    });
    const page2 = second.json<{ items: unknown[]; nextCursor?: string }>();
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
  });

  test('with leadId → plain array (not the envelope)', async () => {
    await createOpp({ leadId: LEAD, valueCents: 100 });
    await createOpp({ leadId: LEAD2, valueCents: 300 });

    const res = await app.inject({ method: 'GET', url: `/api/v1/opportunities?leadId=${LEAD}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<unknown>();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect((body as Array<{ leadId: string }>)[0]?.leadId).toBe(LEAD);
  });

  test('malformed cursor → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/opportunities?cursor=not-a-real-cursor',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/v1/opportunities/:id', () => {
  test('returns the opportunity', async () => {
    const opp = await createOpp({ leadId: LEAD, valueCents: 777 });
    const res = await app.inject({ method: 'GET', url: `/api/v1/opportunities/${String(opp.id)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ valueCents: number }>().valueCents).toBe(777);
  });

  test('unknown id → 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/opportunities/${MISSING}` });
    expect(res.statusCode).toBe(404);
  });

  test('non-uuid id → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/opportunities/abc' });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/v1/opportunities/:id', () => {
  test('stage move → opportunity_stage_changed with from/to as STAGE IDs', async () => {
    const opp = await createOpp({ leadId: LEAD, stageId: STAGE_A, valueCents: 100 });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/opportunities/${String(opp.id)}`,
      payload: { stageId: STAGE_B, actorId: USER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ stageId: string }>().stageId).toBe(STAGE_B);

    const moved = await eventsOfType(LEAD, 'opportunity_stage_changed');
    expect(moved).toHaveLength(1);
    expect(moved[0]?.payload).toMatchObject({
      opportunityId: opp.id,
      from: STAGE_A,
      to: STAGE_B,
    });
    expect(await eventsOfType(LEAD, 'opportunity_closed')).toHaveLength(0);
  });

  test('re-patch to the SAME stage emits no stage event', async () => {
    const opp = await createOpp({ leadId: LEAD, stageId: STAGE_A });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/opportunities/${String(opp.id)}`,
      payload: { stageId: STAGE_A },
    });
    expect(res.statusCode).toBe(200);
    expect(await eventsOfType(LEAD, 'opportunity_stage_changed')).toHaveLength(0);
  });

  test('status → won emits opportunity_closed', async () => {
    const opp = await createOpp({ leadId: LEAD, stageId: STAGE_A, valueCents: 900000 });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/opportunities/${String(opp.id)}`,
      payload: { status: 'won' },
    });
    expect(res.statusCode).toBe(200);
    const closed = await eventsOfType(LEAD, 'opportunity_closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]?.payload).toMatchObject({
      opportunityId: opp.id,
      status: 'won',
      valueCents: 900000,
    });
  });

  test('board move to a won column (stageId + status) emits BOTH events', async () => {
    const opp = await createOpp({ leadId: LEAD, stageId: STAGE_A });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/opportunities/${String(opp.id)}`,
      payload: { stageId: STAGE_WON, status: 'won' },
    });
    expect(res.statusCode).toBe(200);
    expect(await eventsOfType(LEAD, 'opportunity_stage_changed')).toHaveLength(1);
    expect(await eventsOfType(LEAD, 'opportunity_closed')).toHaveLength(1);
  });

  test('empty patch → 400 VALIDATION_FAILED', async () => {
    const opp = await createOpp({ leadId: LEAD });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/opportunities/${String(opp.id)}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  test('bad status value → 400 VALIDATION_FAILED', async () => {
    const opp = await createOpp({ leadId: LEAD });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/opportunities/${String(opp.id)}`,
      payload: { status: 'archived' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('unknown stageId → 400 VALIDATION_FAILED', async () => {
    const opp = await createOpp({ leadId: LEAD });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/opportunities/${String(opp.id)}`,
      payload: { stageId: MISSING },
    });
    expect(res.statusCode).toBe(400);
  });

  test('unknown opportunity id → 404 NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/opportunities/${MISSING}`,
      payload: { status: 'won' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/opportunities/:id', () => {
  test('deletes and returns 204; subsequent GET → 404', async () => {
    const opp = await createOpp({ leadId: LEAD });
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/opportunities/${String(opp.id)}`,
    });
    expect(del.statusCode).toBe(204);
    const get = await app.inject({ method: 'GET', url: `/api/v1/opportunities/${String(opp.id)}` });
    expect(get.statusCode).toBe(404);
  });

  test('unknown id → 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/opportunities/${MISSING}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('DTO conformance (drop-in for MSW → the frozen §C1/§C7 shape)', () => {
  test('POST body, board items, and per-lead items all parse as opportunitySchema', async () => {
    const created = await createOpp({
      leadId: LEAD,
      contactId: CONTACT,
      valueCents: 123456,
      stageId: STAGE_A,
      closeDate: '2026-10-01',
      ownerId: USER,
    });
    // The created resource is a valid §C7 Opportunity DTO (strict — no extra keys).
    expect(() => opportunitySchema.strict().parse(created)).not.toThrow();

    const board = await app.inject({ method: 'GET', url: '/api/v1/opportunities' });
    for (const item of board.json<{ items: unknown[] }>().items) {
      expect(() => opportunitySchema.strict().parse(item)).not.toThrow();
    }

    const perLead = await app.inject({
      method: 'GET',
      url: `/api/v1/opportunities?leadId=${LEAD}`,
    });
    for (const item of perLead.json<unknown[]>()) {
      expect(() => opportunitySchema.strict().parse(item)).not.toThrow();
    }
  });
});
