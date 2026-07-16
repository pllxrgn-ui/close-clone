import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { parse } from '@switchboard/shared';
import { calls, type Db } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import {
  createMockTelephonyProvider,
  type MockTelephonyProvider,
} from '../../providers/telephony/index.ts';
import {
  DialerBusyError,
  DropCallAlreadyFinalizedError,
  DropCallNotDialableError,
  DropCallNotFoundError,
  advanceDialer,
  dropVoicemailOnCall,
  loadDialerQueue,
  type DialerAdvanceDeps,
  type DialerQueueDeps,
  type DropVoicemailDeps,
} from './dialer.ts';
import { addPhoneSuppression } from './suppression.ts';
import {
  activitiesFor,
  callsFor,
  seedContact,
  seedLead,
  seedOrgSettings,
  seedUser,
} from './test-helpers.ts';

/**
 * List dialer (task 3c): SEQUENTIAL advance over a Smart View (one live call per
 * rep, rep-initiated), and voicemail drop into a live outbound call. The queue is
 * compiled by the single query authority; the advance reuses the 3b dial engine
 * (all I-DNC / I-REC rails); the drop records exactly one `call_logged` carrying
 * the audio ref.
 */

const NUM_A = '+13055550147';
const NUM_B = '+13055550148';
const NUM_C = '+13055550149';
const REP_NUMBER = '+15617770123';
const NIL = '00000000-0000-4000-8000-0000000000ff';

let ctx: TestDb;
let db: Db;
let mock: MockTelephonyProvider;
let rep: string;

const NOW = (): Date => new Date('2026-07-15T12:00:00.000Z');

beforeEach(async () => {
  ctx = await createTestDb();
  db = ctx.db;
  mock = createMockTelephonyProvider();
  rep = await seedUser(db, { name: 'Rep' });
  await seedOrgSettings(db, { recordingEnabled: false });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('loadDialerQueue', () => {
  function queueDeps(): DialerQueueDeps {
    return { db, client: ctx.client, orgTimezone: 'UTC', now: NOW };
  }

  test('compiles a Smart View to an ordered queue with dialable annotations', async () => {
    const good = await seedLead(db, { name: 'Good', ownerId: rep });
    await seedContact(db, good, [NUM_A], { name: 'Ann' });
    const dnc = await seedLead(db, { name: 'DncLead', ownerId: rep, dnc: true });
    await seedContact(db, dnc, [NUM_B], { name: 'Bob' });
    const suppressedLead = await seedLead(db, { name: 'Suppressed', ownerId: rep });
    await seedContact(db, suppressedLead, [NUM_C], { name: 'Cid' });
    await addPhoneSuppression(db, { key: '3055550149', source: 'stop_keyword' });

    const ast = parse('owner in (me)', { fieldCatalog: [] });
    const queue = await loadDialerQueue(queueDeps(), { ast, currentUserId: rep });
    const byId = new Map(queue.entries.map((e) => [e.leadId, e]));
    expect(queue.entries).toHaveLength(3);

    expect(byId.get(good)).toMatchObject({ phone: NUM_A, dnc: false, suppressed: false, dialable: true });
    expect(byId.get(dnc)).toMatchObject({ dnc: true, dialable: false });
    expect(byId.get(suppressedLead)).toMatchObject({ suppressed: true, dialable: false });
  });

  test('a lead with no phoned contact surfaces as non-dialable (phone null)', async () => {
    const noPhone = await seedLead(db, { name: 'NoPhone', ownerId: rep });
    const ast = parse('owner in (me)', { fieldCatalog: [] });
    const queue = await loadDialerQueue(queueDeps(), { ast, currentUserId: rep });
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]).toMatchObject({ contactId: null, phone: null, dialable: false });
  });

  test('keyset pagination walks the whole queue without gaps or repeats', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const lead = await seedLead(db, { name: `Lead ${i}`, ownerId: rep });
      await seedContact(db, lead, [NUM_A], { name: `C${i}` });
      ids.push(lead);
    }
    const ast = parse('owner in (me)', { fieldCatalog: [] });

    const seen = new Set<string>();
    const page1 = await loadDialerQueue(queueDeps(), { ast, currentUserId: rep, limit: 2 });
    for (const e of page1.entries) seen.add(e.leadId);
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await loadDialerQueue(queueDeps(), {
      ast,
      currentUserId: rep,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    for (const e of page2.entries) seen.add(e.leadId);
    expect(page2.entries).toHaveLength(2);

    const page3 = await loadDialerQueue(queueDeps(), {
      ast,
      currentUserId: rep,
      limit: 2,
      cursor: page2.nextCursor!,
    });
    for (const e of page3.entries) seen.add(e.leadId);
    expect(page3.entries).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();

    expect(seen.size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  test('an empty result is an empty queue with no cursor', async () => {
    const ast = parse('owner in (me)', { fieldCatalog: [] });
    const queue = await loadDialerQueue(queueDeps(), { ast, currentUserId: rep });
    expect(queue.entries).toHaveLength(0);
    expect(queue.nextCursor).toBeUndefined();
  });
});

describe('advanceDialer — sequential (one live call at a time)', () => {
  function advanceDeps(): DialerAdvanceDeps {
    return { db, provider: mock, now: NOW, callerId: REP_NUMBER };
  }

  test('places the first call, then BLOCKS a second while one is live', async () => {
    const lead = await seedLead(db, { name: 'Acme', ownerId: rep });
    const contact = await seedContact(db, lead, [NUM_A], { name: 'Ann' });

    const first = await advanceDialer(advanceDeps(), { userId: rep, leadId: lead, contactId: contact });
    expect(mock.dialCount).toBe(1);
    // The call is now queued (live) → a second advance is refused.
    const err = await advanceDialer(advanceDeps(), {
      userId: rep,
      leadId: lead,
      contactId: contact,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DialerBusyError);
    expect((err as DialerBusyError).activeCallId).toBeDefined();
    expect(mock.dialCount).toBe(1); // provider never called for the blocked advance
  });

  test('advance succeeds again once the live call reaches a terminal status', async () => {
    const lead = await seedLead(db, { name: 'Acme', ownerId: rep });
    const contact = await seedContact(db, lead, [NUM_A], { name: 'Ann' });
    const first = await advanceDialer(advanceDeps(), { userId: rep, leadId: lead, contactId: contact });
    // Simulate the call ending (status callback would do this in the real flow).
    await db.update(calls).set({ status: 'completed' }).where(eq(calls.id, first.callId));

    const second = await advanceDialer(advanceDeps(), { userId: rep, leadId: lead, contactId: contact });
    expect(second.callId).not.toBe(first.callId);
    expect(mock.dialCount).toBe(2);
  });

  test('a live call for a DIFFERENT rep does not block this rep', async () => {
    const other = await seedUser(db, { name: 'Other' });
    const lead = await seedLead(db, { name: 'Acme', ownerId: rep });
    const contact = await seedContact(db, lead, [NUM_A], { name: 'Ann' });
    await advanceDialer(advanceDeps(), { userId: other, leadId: lead, contactId: contact });
    // rep has no live call → allowed.
    await advanceDialer(advanceDeps(), { userId: rep, leadId: lead, contactId: contact });
    expect(mock.dialCount).toBe(2);
  });
});

describe('dropVoicemailOnCall', () => {
  function dropDeps(): DropVoicemailDeps {
    return { db, provider: mock, now: NOW };
  }

  async function liveOutboundCall(): Promise<{ leadId: string; callId: string }> {
    const lead = await seedLead(db, { name: 'Acme', ownerId: rep });
    const contact = await seedContact(db, lead, [NUM_A], { name: 'Ann' });
    const out = await advanceDialer(
      { db, provider: mock, now: NOW, callerId: REP_NUMBER },
      { userId: rep, leadId: lead, contactId: contact },
    );
    return { leadId: lead, callId: out.callId };
  }

  test('drops the asset, stores the ref, and logs exactly one call_logged', async () => {
    const { leadId, callId } = await liveOutboundCall();
    const res = await dropVoicemailOnCall(dropDeps(), {
      callId,
      recordingRef: 'https://assets.example/vm/rep-intro.mp3',
      actorId: rep,
    });
    expect(res.activity).toBe('call_logged');
    expect(mock.dropVoicemailCount).toBe(1);

    const [call] = await callsFor(db, leadId);
    expect(call).toMatchObject({
      status: 'voicemail',
      outcome: 'voicemail_drop',
      recordingRef: 'https://assets.example/vm/rep-intro.mp3',
    });

    const logged = (await activitiesFor(db, leadId)).filter((a) => a.type === 'call_logged');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.payload).toMatchObject({
      outcome: 'voicemail_drop',
      recordingRef: 'https://assets.example/vm/rep-intro.mp3',
      voicemailDropped: true,
    });
  });

  test('a second drop on the same call is rejected (already finalized), provider not re-called', async () => {
    const { callId } = await liveOutboundCall();
    await dropVoicemailOnCall(dropDeps(), { callId, recordingRef: 'ref-1', actorId: rep });
    const err = await dropVoicemailOnCall(dropDeps(), {
      callId,
      recordingRef: 'ref-2',
      actorId: rep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DropCallAlreadyFinalizedError);
    expect(mock.dropVoicemailCount).toBe(1);
  });

  test('a missing call is DropCallNotFoundError', async () => {
    await expect(
      dropVoicemailOnCall(dropDeps(), { callId: NIL, recordingRef: 'ref' }),
    ).rejects.toBeInstanceOf(DropCallNotFoundError);
  });

  test('an inbound call cannot receive a drop', async () => {
    const lead = await seedLead(db, { name: 'Inbound', ownerId: rep });
    const rows = await db
      .insert(calls)
      .values({
        leadId: lead,
        direction: 'inbound',
        twilioSid: 'CA-inbound-1',
        status: 'ringing',
        startedAt: NOW().toISOString(),
      })
      .returning({ id: calls.id });
    await expect(
      dropVoicemailOnCall(dropDeps(), { callId: rows[0]!.id, recordingRef: 'ref' }),
    ).rejects.toBeInstanceOf(DropCallNotDialableError);
    expect(mock.dropVoicemailCount).toBe(0);
  });

  test('an empty recordingRef is rejected before the provider is touched', async () => {
    const { callId } = await liveOutboundCall();
    await expect(
      dropVoicemailOnCall(dropDeps(), { callId, recordingRef: '' }),
    ).rejects.toBeInstanceOf(DropCallNotDialableError);
    expect(mock.dropVoicemailCount).toBe(0);
  });
});
