import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse } from '@switchboard/shared';

import { contacts, leads, sequenceEnrollments, smartViews, users, type Db } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { seedSequence } from '../services/sequences/test-helpers.ts';
import type { QueueDriver } from '../queue/index.ts';
import type { RawQueryable } from '../services/smartviews/index.ts';
import { registerBulkRoutes } from './bulk.ts';

/**
 * Task R3 — bulk route over `fastify.inject` against PGlite (D-003). Asserts the
 * `POST /api/v1/bulk` wire + the C8 error envelope, and — the point of I-RAIL-API
 * — that the DNC rail still holds when the bulk action is invoked through the HTTP
 * API: a DNC target is never enrolled.
 */

const USER = '00000000-0000-4000-8000-00000000000a';
const NOOP_QUEUE: QueueDriver = {
  enqueue: async () => {},
  process: () => {},
  close: async () => {},
};

let ctx: TestDb;
let db: Db;
let app: FastifyInstance;

function post(body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/bulk',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

async function seedLead(opts: { dnc?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await db.insert(leads).values({
    id,
    name: `Lead ${id.slice(0, 8)}`,
    ownerId: USER,
    ...(opts.dnc === true ? { dnc: true } : {}),
  });
  return id;
}

async function seedContact(leadId: string): Promise<void> {
  await db.insert(contacts).values({
    leadId,
    name: 'Contact',
    emails: [{ email: `c${randomUUID().slice(0, 6)}@t.test`, type: 'work' }],
  });
}

async function seedOwnerView(): Promise<string> {
  const id = randomUUID();
  const dsl = 'owner in (me)';
  await db.insert(smartViews).values({
    id,
    name: dsl,
    ownerId: null,
    shared: true,
    dsl,
    ast: parse(dsl, { fieldCatalog: [] }) as unknown as Record<string, unknown>,
  });
  return id;
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);
  db = ctx.db;
  await db
    .insert(users)
    .values([{ id: USER, email: 'a@t.test', name: 'Rep A', role: 'rep', idpSubject: 'idp|a' }]);

  app = Fastify({ logger: false });
  registerBulkRoutes(app, {
    db,
    client: ctx.client as unknown as RawQueryable,
    orgTimezone: 'UTC',
    queue: NOOP_QUEUE,
    now: () => new Date('2026-03-02T15:00:00.000Z'),
    defaultUserId: USER,
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('POST /api/v1/bulk — wire', () => {
  test('assign returns a { jobId, action, summary } envelope', async () => {
    await seedLead();
    const other = randomUUID();
    await db.insert(users).values({
      id: other,
      email: `o${other.slice(0, 6)}@t.test`,
      name: 'O',
      role: 'rep',
      idpSubject: `idp|${other}`,
    });
    const viewId = await seedOwnerView();

    const res = await post({ smartViewId: viewId, action: 'assign', params: { ownerId: other } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      jobId: string;
      action: string;
      status: string;
      summary: { updated: number };
    };
    expect(body.action).toBe('assign');
    expect(body.status).toBe('completed');
    expect(typeof body.jobId).toBe('string');
    expect(body.summary.updated).toBeGreaterThanOrEqual(1);
  });

  test('export returns serialized content', async () => {
    await seedLead();
    const viewId = await seedOwnerView();
    const res = await post({ smartViewId: viewId, action: 'export', params: { format: 'csv' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { summary: { format: string; content: string } };
    expect(body.summary.format).toBe('csv');
    expect(body.summary.content).toContain('id,name');
  });
});

describe('POST /api/v1/bulk — I-RAIL-API: DNC never enrolled through the API', () => {
  test('a DNC lead in the target set is skipped, not enrolled', async () => {
    const clean = await seedLead();
    await seedContact(clean);
    const dnc = await seedLead({ dnc: true });
    await seedContact(dnc);
    const viewId = await seedOwnerView();
    const { sequenceId } = await seedSequence(db, [{ type: 'call_task', delayHours: 0 }], {
      name: `Seq ${randomUUID().slice(0, 6)}`,
    });

    const res = await post({ smartViewId: viewId, action: 'enroll', params: { sequenceId } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summary: { enrolled: number; skipReasons: Record<string, number> };
    };
    expect(body.summary.skipReasons['dnc']).toBeGreaterThanOrEqual(1);

    // Row-level proof: the DNC lead has no enrollment.
    const dncEnrollments = await db
      .select({ n: count() })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.leadId, dnc));
    expect(Number(dncEnrollments[0]?.n ?? 0)).toBe(0);
  });
});

describe('POST /api/v1/bulk — failure paths', () => {
  test('missing action → 400 VALIDATION_FAILED', async () => {
    const res = await post({ smartViewId: randomUUID() });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  test('set-dnc without a reason → 400 VALIDATION_FAILED', async () => {
    const viewId = await seedOwnerView();
    const res = await post({ smartViewId: viewId, action: 'set-dnc', params: {} });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  test('unknown smartViewId → 404 NOT_FOUND', async () => {
    const res = await post({ smartViewId: randomUUID(), action: 'export' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  test('unknown action → 400 VALIDATION_FAILED', async () => {
    const viewId = await seedOwnerView();
    const res = await post({ smartViewId: viewId, action: 'nuke' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });
});
