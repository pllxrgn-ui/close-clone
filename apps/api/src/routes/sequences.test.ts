import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { registerSequenceWorker } from '../services/sequences/index.ts';
import {
  intentsForEnrollment,
  intentState,
  makeHarness,
  seedAccount,
  seedContact,
  seedLead,
  seedTemplate,
  seedUser,
  setOrgSettings,
  type EngineHarness,
} from '../services/sequences/test-helpers.ts';
import { registerSequenceRoutes } from './sequences.ts';

/**
 * Sequences REST (CONTRACTS §C7) + I-RAIL-API: enrolling and sending THROUGH the
 * API cannot bypass the never-events. Enrolling a DNC lead via HTTP and ticking the
 * worker leaves the intent BLOCKED, never SENT.
 */

let ctx: TestDb;
let h: EngineHarness;
let app: FastifyInstance;
let rep: string;
let account: string;
let template: string;

beforeEach(async () => {
  ctx = await createTestDb();
  h = makeHarness(ctx.db);
  rep = await seedUser(ctx.db, 'rep@switchboard.test');
  account = await seedAccount(ctx.db, h.cipher, rep, 'rep@mock.test');
  template = await seedTemplate(ctx.db, rep);
  await setOrgSettings(ctx.db, {});
  app = Fastify({ logger: false });
  registerSequenceRoutes(app, { db: ctx.db, queue: h.queue, now: h.deps.now });
  await app.ready();
}, 120_000);

afterEach(async () => {
  await app.close();
  await ctx.close();
});

async function createSeq(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/sequences',
    payload: { name: 'Onboarding', steps: [{ type: 'email', delayHours: 0, templateId: template }] },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ sequence: { id: string } }>().sequence.id;
}

describe('CRUD', () => {
  test('create → get → list → archive', async () => {
    const id = await createSeq();

    const got = await app.inject({ method: 'GET', url: `/api/v1/sequences/${id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ steps: unknown[] }>().steps).toHaveLength(1);

    const list = await app.inject({ method: 'GET', url: '/api/v1/sequences' });
    expect(list.json<{ items: unknown[] }>().items.length).toBeGreaterThanOrEqual(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sequences/${id}`,
      payload: { status: 'archived' },
    });
    expect(patched.json<{ status: string }>().status).toBe('archived');
  });

  test('creating an email step without a template is 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sequences',
      payload: { name: 'Bad', steps: [{ type: 'email', delayHours: 0 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('enroll', () => {
  test('bulk enroll returns enrolled + skipped', async () => {
    const id = await createSeq();
    const lead = await seedLead(ctx.db, 'Acme');
    const contact = await seedContact(ctx.db, lead, 'dana@acme.test');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sequences/${id}/enroll`,
      payload: { enrolledBy: rep, emailAccountId: account, targets: [{ leadId: lead, contactId: contact }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ enrolled: unknown[] }>().enrolled).toHaveLength(1);
  });

  test('I-RAIL-API: enrolling a DNC lead via HTTP never sends — intent BLOCKED', async () => {
    registerSequenceWorker(h.deps); // worker shares the same queue as the route
    const id = await createSeq();
    const lead = await seedLead(ctx.db, 'DNC Co', { dnc: true });
    const contact = await seedContact(ctx.db, lead, 'nope@dnc.test');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sequences/${id}/enroll`,
      payload: { enrolledBy: rep, emailAccountId: account, targets: [{ leadId: lead, contactId: contact }] },
    });
    const enrollmentId = res.json<{ enrolled: { enrollmentId: string }[] }>().enrolled[0]!.enrollmentId;

    // Drive the wake-up the enroll enqueued.
    await h.queue.tick();
    const intentId = (await intentsForEnrollment(ctx.db, enrollmentId))[0]!.id;
    expect((await intentState(ctx.db, intentId)).state).toBe('BLOCKED');
    expect(h.providers.get('rep@mock.test')?.deliveredCount ?? 0).toBe(0);
  });
});
