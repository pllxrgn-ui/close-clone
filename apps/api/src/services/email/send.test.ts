import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { emailAccounts, emailMessages, suppressions, type Db } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { MockEmailProvider } from '../../providers/mock/mock-email-provider.ts';
import { TokenCipher } from '../sync/token-cipher.ts';
import { createTemplate } from '../templates/index.ts';
import {
  SendAccountNotFoundError,
  SendContactNotFoundError,
  SendLeadNotFoundError,
  SendValidationError,
  SuppressedError,
  sendOneOff,
  type SendOneOffInput,
  type SendServiceDeps,
} from './send.ts';
import { MergeRenderError } from './merge.ts';
import { ParticipantLeadMatcher } from './matching.ts';
import {
  activitiesFor,
  ingest,
  leadTouch,
  makeRaw,
  seedContact,
  seedLead,
  seedUser,
  threadsFor,
} from './test-helpers.ts';

/**
 * One-off send engine (task 2d, CONTRACTS §C6 I-DNC / §C8). The engine is the
 * ONLY path to `EmailProvider.send` for one-off mail: it renders merge tags,
 * enforces suppression + contact/lead DNC at execution time (throws typed
 * `SUPPRESSED`, never an override prompt), sends per-account (send-from is the
 * rep's own mailbox), and lands the sent message in `email_messages`/`email_threads`
 * consistent with 2c threading — writing exactly one `email_sent` activity via the
 * ActivityWriter. Idempotent on a client key. All under MOCK_MODE / PGlite.
 */

const SECRET = 'send-suite-secret';

let ctx: TestDb;
let cipher: TokenCipher;
let providers: Map<string, MockEmailProvider>;
let deps: SendServiceDeps;
let rep: string;

function providerFor(identity: { address: string; provider: 'gmail' | 'mock' }): MockEmailProvider {
  const key = identity.address.toLowerCase();
  let p = providers.get(key);
  if (p === undefined) {
    p = new MockEmailProvider({ address: identity.address });
    providers.set(key, p);
  }
  return p;
}

function encToken(): string {
  return cipher.encrypt({
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    tokenType: 'Bearer',
  });
}

async function seedAccount(db: Db, userId: string, address: string, withTokens = true): Promise<string> {
  const rows = await db
    .insert(emailAccounts)
    .values({
      userId,
      address,
      provider: 'mock',
      syncStatus: 'LIVE',
      oauthTokens: withTokens ? encToken() : null,
    })
    .returning({ id: emailAccounts.id });
  return rows[0]!.id;
}

async function addSuppression(db: Db, value: string): Promise<void> {
  await db.insert(suppressions).values({ kind: 'email', value, source: 'unsubscribe' });
}

beforeEach(async () => {
  ctx = await createTestDb();
  cipher = new TokenCipher(SECRET);
  providers = new Map();
  deps = { db: ctx.db, providerFor, cipher };
  rep = await seedUser(ctx.db, { email: 'rep@example.com' });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('happy path', () => {
  test('sends to a contact, writes exactly one email_sent, threads + advances denorm', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');

    const res = await sendOneOff(deps, {
      actorId: rep,
      accountId,
      leadId: lead,
      to: ['dana@acme.test'],
      subject: 'Hello {{lead.name}}',
      body: 'Hi from {{user.name}}',
    });

    expect(res.deduped).toBe(false);
    expect(res.providerMessageId).toBeTruthy();

    const msgs = await ctx.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.accountId, accountId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.direction).toBe('out');
    expect(msgs[0]!.fromAddr).toBe('rep@mock.test');

    const acts = await activitiesFor(ctx.db, lead);
    expect(acts.filter((a) => a.type === 'email_sent')).toHaveLength(1);

    const threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.triageStatus).toBe('matched');
    expect(threads[0]!.leadId).toBe(lead);

    const touch = await leadTouch(ctx.db, lead);
    expect(touch.lastEmailAt).not.toBeNull();
    expect(touch.lastContactedAt).not.toBeNull();

    expect(providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount).toBe(1);
  });

  test('renders merge tags into the actual sent body — no raw braces', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const cid = await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');

    const res = await sendOneOff(deps, {
      actorId: rep,
      accountId,
      leadId: lead,
      contactId: cid,
      subject: 'For {{contact.name}}',
      body: 'Hi {{contact.name}} at {{lead.name}} — {{user.email}}',
    });

    const provider = providerFor({ address: 'rep@mock.test', provider: 'mock' });
    const tokens = cipher.decrypt(
      (await ctx.db.select().from(emailAccounts).where(eq(emailAccounts.id, accountId)))[0]!.oauthTokens!,
    );
    const sent = await provider.getMessage(tokens, res.providerMessageId);
    expect(sent.subject).toBe('For Dana');
    expect(sent.bodyText).toBe('Hi Dana at Acme — rep@example.com');
    expect(sent.bodyText).not.toContain('{{');
  });

  test('defaults the recipient to the contact primary email', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const cid = await seedContact(ctx.db, lead, ['primary@acme.test'], { name: 'Dana' });
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');

    const res = await sendOneOff(deps, { actorId: rep, accountId, leadId: lead, contactId: cid, body: 'Hi' });
    const msg = (await ctx.db.select().from(emailMessages).where(eq(emailMessages.id, res.messageId)))[0]!;
    expect(msg.toAddrs).toEqual(['primary@acme.test']);
  });
});

describe('compliance rails — I-DNC (execution-time, engine layer)', () => {
  test('a suppressed recipient throws SUPPRESSED and never calls the provider', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['blocked@acme.test'], { name: 'Dana' });
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');
    await addSuppression(ctx.db, 'blocked@acme.test');

    await expect(
      sendOneOff(deps, { actorId: rep, accountId, leadId: lead, to: ['blocked@acme.test'], body: 'Hi' }),
    ).rejects.toBeInstanceOf(SuppressedError);

    expect(providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount).toBe(0);
    const msgs = await ctx.db.select().from(emailMessages).where(eq(emailMessages.accountId, accountId));
    expect(msgs).toHaveLength(0);
    expect(await activitiesFor(ctx.db, lead)).toHaveLength(0);
  });

  test('suppression match is case-insensitive', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');
    await addSuppression(ctx.db, 'Blocked@Acme.test');
    await expect(
      sendOneOff(deps, { actorId: rep, accountId, leadId: lead, to: ['blocked@acme.TEST'], body: 'Hi' }),
    ).rejects.toBeInstanceOf(SuppressedError);
  });

  test('lead DNC blocks the send', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await ctx.db.execute(
      // set dnc via a raw update to avoid depending on a lead service
      // eslint-disable-next-line
      (await import('drizzle-orm')).sql`UPDATE leads SET dnc = true WHERE id = ${lead}`,
    );
    await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');
    await expect(
      sendOneOff(deps, { actorId: rep, accountId, leadId: lead, to: ['dana@acme.test'], body: 'Hi' }),
    ).rejects.toBeInstanceOf(SuppressedError);
    expect(providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount).toBe(0);
  });

  test('contact DNC blocks the send', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const cid = await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
    await ctx.db.execute(
      (await import('drizzle-orm')).sql`UPDATE contacts SET dnc = true WHERE id = ${cid}`,
    );
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');
    await expect(
      sendOneOff(deps, { actorId: rep, accountId, leadId: lead, contactId: cid, body: 'Hi' }),
    ).rejects.toBeInstanceOf(SuppressedError);
    expect(providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount).toBe(0);
  });
});

describe('merge-tag failure', () => {
  test('an unresolved required tag is VALIDATION_FAILED and nothing is sent', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const cid = await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');
    await expect(
      sendOneOff(deps, {
        actorId: rep,
        accountId,
        leadId: lead,
        contactId: cid,
        body: 'Hi {{contact.title}}', // contact has no title
      }),
    ).rejects.toBeInstanceOf(MergeRenderError);
    expect(providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount).toBe(0);
    expect(await ctx.db.select().from(emailMessages).where(eq(emailMessages.accountId, accountId))).toHaveLength(
      0,
    );
  });
});

describe('idempotency', () => {
  test('a double send with the same key sends once and writes one activity', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');

    const input: SendOneOffInput = {
      actorId: rep,
      accountId,
      leadId: lead,
      to: ['dana@acme.test'],
      body: 'Hi',
      idempotencyKey: 'oneoff-123',
    };

    const first = await sendOneOff(deps, { ...input });
    const second = await sendOneOff(deps, { ...input });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(second.rfcMessageId).toBe(first.rfcMessageId);

    expect(providerFor({ address: 'rep@mock.test', provider: 'mock' }).sendCallCount).toBe(1);
    const msgs = await ctx.db.select().from(emailMessages).where(eq(emailMessages.accountId, accountId));
    expect(msgs).toHaveLength(1);
    expect((await activitiesFor(ctx.db, lead)).filter((a) => a.type === 'email_sent')).toHaveLength(1);
  });
});

describe('thread continuity — reply from CRM', () => {
  test('a reply lands in the inbound thread; both activities on the lead', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');

    // Inbound from the contact → threaded + matched to the lead (2c), one email_received.
    // (Explicit providerMessageId so the seeded inbound cannot collide with the
    // send mailbox's own 'msg-N' id sequence — real mailboxes never share one.)
    const inbound = await ingest(ctx.db, { matcher: new ParticipantLeadMatcher() }, accountId, makeRaw({
      providerMessageId: 'inbound-pm-1',
      rfcMessageId: '<inbound-1@ext.test>',
      from: 'dana@acme.test',
      to: ['rep@mock.test'],
      subject: 'Question',
    }));
    const inboundMsg = (
      await ctx.db
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(and(eq(emailMessages.accountId, accountId), eq(emailMessages.rfcMessageId, '<inbound-1@ext.test>')))
    )[0]!;

    const res = await sendOneOff(deps, {
      actorId: rep,
      accountId,
      leadId: lead,
      to: ['dana@acme.test'],
      subject: 'Re: Question',
      body: 'Answer',
      inReplyToMessageId: inboundMsg.id,
    });

    // Single thread, two messages.
    const threads = await threadsFor(ctx.db, accountId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe(res.threadId);
    expect(threads[0]!.messageRfcIds).toHaveLength(2);
    expect(threads[0]!.triageStatus).toBe('matched');
    expect(threads[0]!.leadId).toBe(lead);

    const acts = await activitiesFor(ctx.db, lead);
    expect(acts.filter((a) => a.type === 'email_received')).toHaveLength(1);
    expect(acts.filter((a) => a.type === 'email_sent')).toHaveLength(1);

    expect(inbound.threadId).toBe(res.threadId);
  });
});

describe('per-account send-from', () => {
  test('the From is the sending account address; only that mailbox provider is used', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
    const accountA = await seedAccount(ctx.db, rep, 'a@mock.test');
    const accountB = await seedAccount(ctx.db, rep, 'b@mock.test');

    const res = await sendOneOff(deps, {
      actorId: rep,
      accountId: accountB,
      leadId: lead,
      to: ['dana@acme.test'],
      body: 'Hi',
    });
    const msg = (await ctx.db.select().from(emailMessages).where(eq(emailMessages.id, res.messageId)))[0]!;
    expect(msg.fromAddr).toBe('b@mock.test');
    expect(providerFor({ address: 'b@mock.test', provider: 'mock' }).sendCallCount).toBe(1);
    expect(providerFor({ address: 'a@mock.test', provider: 'mock' }).sendCallCount).toBe(0);
    expect(accountA).not.toBe(accountB);
  });
});

describe('template-based send', () => {
  test('renders subject/body from a visible template', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const cid = await seedContact(ctx.db, lead, ['dana@acme.test'], { name: 'Dana' });
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');
    const tpl = await createTemplate(ctx.db, {
      actorId: rep,
      name: 'Intro',
      channel: 'email',
      subject: 'Hi {{contact.name}}',
      body: 'Welcome to {{lead.name}}',
    });

    const res = await sendOneOff(deps, {
      actorId: rep,
      accountId,
      leadId: lead,
      contactId: cid,
      templateId: tpl.id,
    });
    const provider = providerFor({ address: 'rep@mock.test', provider: 'mock' });
    const tokens = cipher.decrypt(
      (await ctx.db.select().from(emailAccounts).where(eq(emailAccounts.id, accountId)))[0]!.oauthTokens!,
    );
    const sent = await provider.getMessage(tokens, res.providerMessageId);
    expect(sent.subject).toBe('Hi Dana');
    expect(sent.bodyText).toBe('Welcome to Acme');
  });

  test('rejects an SMS template on the email send path', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');
    const tpl = await createTemplate(ctx.db, { actorId: rep, name: 'Sms', channel: 'sms', body: 'x' });
    await expect(
      sendOneOff(deps, { actorId: rep, accountId, leadId: lead, to: ['x@y.z'], templateId: tpl.id }),
    ).rejects.toBeInstanceOf(SendValidationError);
  });
});

describe('validation / not-found', () => {
  test('no recipient is VALIDATION_FAILED', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');
    await expect(
      sendOneOff(deps, { actorId: rep, accountId, leadId: lead, body: 'Hi' }),
    ).rejects.toBeInstanceOf(SendValidationError);
  });

  test('missing account / lead / contact are NOT_FOUND', async () => {
    const lead = await seedLead(ctx.db, 'Acme');
    const accountId = await seedAccount(ctx.db, rep, 'rep@mock.test');
    const NIL = '00000000-0000-4000-8000-0000000000ff';
    await expect(
      sendOneOff(deps, { actorId: rep, accountId: NIL, leadId: lead, to: ['x@y.z'], body: 'Hi' }),
    ).rejects.toBeInstanceOf(SendAccountNotFoundError);
    await expect(
      sendOneOff(deps, { actorId: rep, accountId, leadId: NIL, to: ['x@y.z'], body: 'Hi' }),
    ).rejects.toBeInstanceOf(SendLeadNotFoundError);
    await expect(
      sendOneOff(deps, { actorId: rep, accountId, leadId: lead, contactId: NIL, body: 'Hi' }),
    ).rejects.toBeInstanceOf(SendContactNotFoundError);
  });
});
