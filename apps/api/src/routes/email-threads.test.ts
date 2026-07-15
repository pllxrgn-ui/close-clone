import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { ParticipantLeadMatcher } from '../services/email/index.ts';
import {
  ingest,
  makeRaw,
  seedAccount,
  seedContact,
  seedLead,
  seedUser,
} from '../services/email/test-helpers.ts';

/**
 * Email thread READ surface (CONTRACTS §C7, task 2d): GET /api/v1/emails/threads
 * (list, ?leadId=) and GET /api/v1/emails/threads/:id (thread + messages). Backs
 * the lead conversation view + reply-from-CRM message picker.
 */

let ctx: TestDb;
let app: FastifyInstance;
let accountId: string;
let lead: string;

beforeEach(async () => {
  ctx = await createTestDb();
  const owner = await seedUser(ctx.db, { email: 'owner@example.com' });
  accountId = await seedAccount(ctx.db, owner, 'rep@mock.test');
  lead = await seedLead(ctx.db, 'Acme');
  await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
  // Inbound from the contact → threaded + matched to the lead (2c).
  await ingest(
    ctx.db,
    { matcher: new ParticipantLeadMatcher() },
    accountId,
    makeRaw({
      rfcMessageId: '<t1@ext.test>',
      from: 'dana@acme.test',
      to: ['rep@mock.test'],
      subject: 'Question',
    }),
  );
  app = buildServer({ db: ctx.db });
  await app.ready();
}, 120_000);

afterEach(async () => {
  await app.close();
  await ctx.close();
});

describe('GET /api/v1/emails/threads', () => {
  test('lists threads for a lead with counts', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/emails/threads?leadId=${lead}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: { threadId: string; leadId: string; messageCount: number }[];
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.leadId).toBe(lead);
    expect(body.items[0]!.messageCount).toBe(1);
  });

  test('a bad leadId is 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/emails/threads?leadId=not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/emails/threads/:id', () => {
  test('returns the thread with its messages', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/emails/threads?leadId=${lead}` });
    const threadId = list.json<{ items: { threadId: string }[] }>().items[0]!.threadId;
    const res = await app.inject({ method: 'GET', url: `/api/v1/emails/threads/${threadId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      threadId: string;
      messages: { direction: string; rfcMessageId: string }[];
    }>();
    expect(body.threadId).toBe(threadId);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.direction).toBe('in');
    expect(body.messages[0]!.rfcMessageId).toBe('<t1@ext.test>');
  });

  test('an unknown thread id is 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/emails/threads/00000000-0000-4000-8000-0000000000ff',
    });
    expect(res.statusCode).toBe(404);
  });
});
