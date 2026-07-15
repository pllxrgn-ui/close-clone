import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  activities,
  contacts,
  leads,
  opportunities,
  opportunityStages,
  sequenceEnrollments,
  sequences,
  users,
} from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { registerReportsRoutes } from './reports.ts';

/**
 * Task 4g — reporting routes (`GET /api/v1/reports/{activity,funnel,sequences}`,
 * CONTRACTS §C7/§C8). Drives the plugin factory through `fastify.inject` against
 * a PGlite DB. The plugin is registered directly (it is intentionally not wired
 * into `routes/index.ts`, which is outside this task's allowlist). Asserts the
 * `{ items, nextCursor? }` envelope, cursor flow, and the VALIDATION_FAILED
 * failure paths (bad query, bad range, bad cursor).
 */

const USER = '00000000-0000-4000-8000-00000000000a';
const LEAD = '11111111-0000-4000-8000-000000000001';
const CONTACT = '66666666-0000-4000-8000-000000000001';
const STAGE = '22222222-0000-4000-8000-0000000000d1';
const OPP = '33333333-0000-4000-8000-000000000001';
const SEQ1 = '44444444-0000-4000-8000-000000000001';
const SEQ2 = '44444444-0000-4000-8000-000000000002';
const ENR = '55555555-0000-4000-8000-000000000001';
const WHEN = '2026-03-10T12:00:00.000Z';

let ctx: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);

  await ctx.db
    .insert(users)
    .values([{ id: USER, email: 'a@example.com', name: 'Rep A', role: 'rep', idpSubject: 'idp|a' }]);
  await ctx.db.insert(leads).values([{ id: LEAD, name: 'Acme', ownerId: USER }]);
  await ctx.db.insert(contacts).values([{ id: CONTACT, leadId: LEAD, name: 'Contact' }]);
  await ctx.db.insert(opportunityStages).values([{ id: STAGE, label: 'Discovery', sortOrder: 0 }]);
  await ctx.db.insert(opportunities).values([
    { id: OPP, leadId: LEAD, currency: 'USD', stageId: STAGE, status: 'active', valueCents: 100000, confidence: 50 },
  ]);
  await ctx.db.insert(sequences).values([
    { id: SEQ1, name: 'Onboarding', status: 'active' },
    { id: SEQ2, name: 'Renewal', status: 'active' },
  ]);
  await ctx.db
    .insert(sequenceEnrollments)
    .values([{ id: ENR, sequenceId: SEQ1, leadId: LEAD, contactId: CONTACT, state: 'active' }]);

  await ctx.db.insert(activities).values([
    { id: randomUUID(), leadId: LEAD, userId: USER, type: 'call_logged', occurredAt: WHEN, payload: { direction: 'inbound', outcome: 'connected' } },
    { id: randomUUID(), leadId: LEAD, userId: USER, type: 'call_logged', occurredAt: WHEN, payload: { direction: 'outbound', outcome: 'voicemail' } },
    { id: randomUUID(), leadId: LEAD, userId: USER, type: 'email_sent', occurredAt: WHEN, payload: {} },
    { id: randomUUID(), leadId: LEAD, userId: USER, type: 'opportunity_stage_changed', occurredAt: WHEN, payload: { opportunityId: OPP, to: STAGE } },
    { id: randomUUID(), leadId: LEAD, userId: USER, type: 'sequence_step_sent', occurredAt: WHEN, payload: { enrollmentId: ENR } },
  ]);

  app = Fastify({ logger: false });
  registerReportsRoutes(app, { db: ctx.db });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

const RANGE = 'from=2026-03-01&to=2026-03-31';

describe('GET /api/v1/reports/activity', () => {
  test('returns the { items } envelope with per-rep counts', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/reports/activity?${RANGE}&groupBy=user` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { bucket: string; callsLogged: number }[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.bucket).toBe(USER);
    expect(body.items[0]?.callsLogged).toBe(2);
  });

  test('missing `to` → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/activity?from=2026-03-01' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  test('unknown groupBy → 400', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/reports/activity?${RANGE}&groupBy=week` });
    expect(res.statusCode).toBe(400);
  });

  test('a non-calendar date → 400 (ReportRangeError mapped)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/activity?from=2026-02-30&to=2026-03-01' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  test('an over-366-day range → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/activity?from=2020-01-01&to=2026-01-01' });
    expect(res.statusCode).toBe(400);
  });

  test('an inverted range → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/activity?from=2026-03-31&to=2026-03-01' });
    expect(res.statusCode).toBe(400);
  });

  test('a malformed cursor → 400 (InvalidCursorError mapped)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/reports/activity?${RANGE}&cursor=not-a-cursor!!` });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/v1/reports/funnel', () => {
  test('returns the pipeline envelope', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/reports/funnel?${RANGE}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { currency: string; stageId: string; openCount: number }[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ currency: 'USD', stageId: STAGE, openCount: 1 });
  });

  test('works all-time (no range)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/funnel' });
    expect(res.statusCode).toBe(200);
  });

  test('`from` without `to` → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/funnel?from=2026-03-01' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/reports/sequences', () => {
  test('returns per-sequence rows', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/reports/sequences?${RANGE}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { sequenceName: string; sends: number }[] }>();
    expect(body.items.map((r) => r.sequenceName)).toEqual(['Onboarding', 'Renewal']);
  });

  test('paginates via limit + nextCursor (cursor flows through HTTP)', async () => {
    const p1 = await app.inject({ method: 'GET', url: `/api/v1/reports/sequences?${RANGE}&limit=1` });
    expect(p1.statusCode).toBe(200);
    const b1 = p1.json<{ items: { sequenceName: string }[]; nextCursor?: string }>();
    expect(b1.items).toHaveLength(1);
    expect(b1.items[0]?.sequenceName).toBe('Onboarding');
    expect(typeof b1.nextCursor).toBe('string');

    const p2 = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/sequences?${RANGE}&limit=1&cursor=${encodeURIComponent(b1.nextCursor ?? '')}`,
    });
    expect(p2.statusCode).toBe(200);
    const b2 = p2.json<{ items: { sequenceName: string }[]; nextCursor?: string }>();
    expect(b2.items[0]?.sequenceName).toBe('Renewal');
    expect(b2.nextCursor).toBeUndefined();
  });

  test('a bogus sequenceId (non-uuid) → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/sequences?sequenceId=nope' });
    expect(res.statusCode).toBe(400);
  });
});
