import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { AmbiguousLeadMatcher } from '../services/sync/matcher.ts';
import {
  activitiesFor,
  auditFor,
  ingest,
  makeRaw,
  seedAccount,
  seedLead,
  seedUser,
  threadsFor,
} from '../services/email/test-helpers.ts';

/**
 * Triage queue REST surface (CONTRACTS §C7/§C8, task 2c). Drives the routes
 * through `fastify.inject` against a real PGlite DB: the list envelope, resolve
 * (with audit + activity side effects — proving the API cannot bypass the engine
 * rails), ignore, and the full C8 failure taxonomy (validation, not-found,
 * forbidden, conflict).
 */

const NIL = '00000000-0000-4000-8000-0000000000ff';
const deps = { matcher: new AmbiguousLeadMatcher() };

let ctx: TestDb;
let app: FastifyInstance;
let accountId: string;
let actor: string;

beforeEach(async () => {
  ctx = await createTestDb();
  const owner = await seedUser(ctx.db, { email: 'owner@example.com' });
  accountId = await seedAccount(ctx.db, owner);
  actor = await seedUser(ctx.db, { email: 'triager@example.com' });
  app = buildServer({ db: ctx.db });
  await app.ready();
}, 120_000);

afterEach(async () => {
  await app.close();
  await ctx.close();
});

async function ambiguousThread(rfc: string, subject: string): Promise<string> {
  const res = await ingest(ctx.db, deps, accountId, makeRaw({ rfcMessageId: rfc, subject }));
  return res.threadId!;
}

describe('GET /api/v1/emails/triage', () => {
  test('returns the { items } envelope of ambiguous threads', async () => {
    await ambiguousThread('<a@x>', 'Alpha');
    const res = await app.inject({ method: 'GET', url: '/api/v1/emails/triage' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Record<string, unknown>[]; nextCursor?: string }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toHaveProperty('threadId');
    expect(body.items[0]).toHaveProperty('participants');
    expect(body.items[0]).toHaveProperty('candidateLeadIds');
    expect(body.items[0]).toHaveProperty('messageCount');
  });

  test('paginates via limit + nextCursor', async () => {
    await ambiguousThread('<a@x>', 'Alpha');
    await ambiguousThread('<b@x>', 'Beta');
    const p1 = await app.inject({ method: 'GET', url: '/api/v1/emails/triage?limit=1' });
    const b1 = p1.json<{ items: { threadId: string }[]; nextCursor?: string }>();
    expect(b1.items).toHaveLength(1);
    expect(typeof b1.nextCursor).toBe('string');

    const p2 = await app.inject({
      method: 'GET',
      url: `/api/v1/emails/triage?limit=1&cursor=${encodeURIComponent(b1.nextCursor ?? '')}`,
    });
    const b2 = p2.json<{ items: { threadId: string }[] }>();
    expect(b2.items).toHaveLength(1);
    expect(b2.items[0]!.threadId).not.toBe(b1.items[0]!.threadId);
  });

  test('bad limit → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/emails/triage?limit=999' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  test('malformed cursor → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/emails/triage?cursor=%21%21bad' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/v1/emails/triage/:threadId/resolve', () => {
  test('resolves to a lead and — via the engine — writes activities + an audit row', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    const lead = await seedLead(ctx.db, 'Acme');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${thread}/resolve`,
      payload: { leadId: lead, actorId: actor, reason: 'clearly Acme' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ triageStatus: string }>().triageStatus).toBe('matched');

    // Side effects went through the same engine path — no API bypass.
    expect((await threadsFor(ctx.db, accountId))[0]!.leadId).toBe(lead);
    expect(await activitiesFor(ctx.db, lead)).toHaveLength(1);
    const audit = await auditFor(ctx.db, thread);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(actor);
  });

  test('non-uuid thread id → 400', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/emails/triage/not-a-uuid/resolve',
      payload: { leadId: lead, actorId: actor },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  test('missing actorId → 400 (no anonymous resolve)', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    const lead = await seedLead(ctx.db, 'Acme');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${thread}/resolve`,
      payload: { leadId: lead },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  test('unknown thread → 404 NOT_FOUND', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${NIL}/resolve`,
      payload: { leadId: lead, actorId: actor },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  test('unknown lead → 404 NOT_FOUND', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${thread}/resolve`,
      payload: { leadId: NIL, actorId: actor },
    });
    expect(res.statusCode).toBe(404);
  });

  test('inactive actor → 403 FORBIDDEN (RBAC-safe default)', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    const lead = await seedLead(ctx.db, 'Acme');
    const inactive = await seedUser(ctx.db, { email: 'ex@example.com', isActive: false });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${thread}/resolve`,
      payload: { leadId: lead, actorId: inactive },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
  });

  test('re-pointing a matched thread to a different lead → 409 CONFLICT', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    const l1 = await seedLead(ctx.db, 'Acme');
    const l2 = await seedLead(ctx.db, 'Beta');
    await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${thread}/resolve`,
      payload: { leadId: l1, actorId: actor },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${thread}/resolve`,
      payload: { leadId: l2, actorId: actor },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
  });
});

describe('POST /api/v1/emails/triage/:threadId/ignore', () => {
  test('ignores an ambiguous thread', async () => {
    const thread = await ambiguousThread('<a@x>', 'Spam');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${thread}/ignore`,
      payload: { actorId: actor, reason: 'newsletter' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ triageStatus: string }>().triageStatus).toBe('ignored');
    expect((await threadsFor(ctx.db, accountId))[0]!.triageStatus).toBe('ignored');
    expect(await auditFor(ctx.db, thread)).toHaveLength(1);
  });

  test('missing actorId → 400', async () => {
    const thread = await ambiguousThread('<a@x>', 'Spam');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${thread}/ignore`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  test('ignoring a matched thread → 409 CONFLICT', async () => {
    const thread = await ambiguousThread('<a@x>', 'Deal');
    const lead = await seedLead(ctx.db, 'Acme');
    await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${thread}/resolve`,
      payload: { leadId: lead, actorId: actor },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/emails/triage/${thread}/ignore`,
      payload: { actorId: actor },
    });
    expect(res.statusCode).toBe(409);
  });
});
