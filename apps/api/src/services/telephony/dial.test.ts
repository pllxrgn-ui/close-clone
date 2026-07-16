import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import {
  createMockTelephonyProvider,
  type MockTelephonyProvider,
} from '../../providers/telephony/index.ts';
import {
  CallNotFoundError,
  DialBlockedError,
  DialContactNotFoundError,
  DialLeadNotFoundError,
  DialValidationError,
  dialCall,
  patchCall,
  type DialDeps,
} from './dial.ts';
import { addPhoneSuppression } from './suppression.ts';
import {
  activitiesFor,
  callsFor,
  notesFor,
  seedContact,
  seedLead,
  seedOrgSettings,
  seedUser,
} from './test-helpers.ts';

/**
 * Dial engine (task 3b): the ONLY path a browser dial reaches the provider, so it
 * owns I-DNC (hard BLOCK, never an override) and I-REC (record ⇒ consent, gated on
 * org recording being enabled). patchCall attaches a REP note (never AI — I-AI is
 * satisfied trivially here: ai_generated=false).
 */

const REP_NUMBER = '+15617770123';
const LEAD_NUMBER = '+13055550147';
const NIL = '00000000-0000-4000-8000-0000000000ff';

let ctx: TestDb;
let mock: MockTelephonyProvider;
let deps: DialDeps;
let rep: string;
let lead: string;
let contact: string;

beforeEach(async () => {
  ctx = await createTestDb();
  mock = createMockTelephonyProvider();
  deps = {
    db: ctx.db,
    provider: mock,
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    callerId: REP_NUMBER,
  };
  rep = await seedUser(ctx.db, { name: 'Rep' });
  lead = await seedLead(ctx.db, { name: 'Acme' });
  contact = await seedContact(ctx.db, lead, [LEAD_NUMBER], { name: 'Dana' });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('happy path', () => {
  test('dials the contact number and creates a queued outbound call row', async () => {
    await seedOrgSettings(ctx.db, { recordingEnabled: false });
    const out = await dialCall(deps, { userId: rep, leadId: lead, contactId: contact });
    expect(mock.dialCount).toBe(1);
    expect(out.to).toBe(LEAD_NUMBER);
    expect(out.from).toBe(REP_NUMBER);
    expect(out.recording).toBe(false);

    const [call] = await callsFor(ctx.db, lead);
    expect(call?.direction).toBe('outbound');
    expect(call?.status).toBe('queued');
    expect(call?.twilioSid).toBe(out.callSid);
    expect(call?.userId).toBe(rep);
  });
});

describe('I-REC — recording only with consent, only when org-enabled', () => {
  test('arms recording + consent together when org recording is enabled', async () => {
    await seedOrgSettings(ctx.db, { recordingEnabled: true });
    const out = await dialCall(deps, { userId: rep, leadId: lead, contactId: contact });
    expect(out.recording).toBe(true);
    // The mock only emits a consent marker + recording when BOTH flags are set.
    const lifecycle = mock.lifecycleFor(out.callSid);
    expect(lifecycle.some((e) => e.type === 'recording_consent_played')).toBe(true);
    expect(lifecycle.some((e) => e.type === 'recording_completed')).toBe(true);
  });

  test('does not record when org recording is disabled', async () => {
    await seedOrgSettings(ctx.db, { recordingEnabled: false });
    const out = await dialCall(deps, { userId: rep, leadId: lead, contactId: contact });
    expect(out.recording).toBe(false);
    expect(mock.lifecycleFor(out.callSid).some((e) => e.type === 'recording_consent_played')).toBe(
      false,
    );
  });

  test('honours a per-call rep opt-out even when org recording is enabled', async () => {
    await seedOrgSettings(ctx.db, { recordingEnabled: true });
    const out = await dialCall(deps, {
      userId: rep,
      leadId: lead,
      contactId: contact,
      recordOptOut: true,
    });
    expect(out.recording).toBe(false);
  });
});

describe('I-DNC — hard block at dial time, provider never called', () => {
  test('a DNC lead is blocked (lead_dnc), no dial, no call row', async () => {
    await seedOrgSettings(ctx.db);
    const dncLead = await seedLead(ctx.db, { name: 'NoContact', dnc: true });
    const dncContact = await seedContact(ctx.db, dncLead, [LEAD_NUMBER]);
    const err = await dialCall(deps, {
      userId: rep,
      leadId: dncLead,
      contactId: dncContact,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DialBlockedError);
    expect((err as DialBlockedError).reason).toBe('lead_dnc');
    expect(mock.dialCount).toBe(0);
    expect(await callsFor(ctx.db, dncLead)).toHaveLength(0);
  });

  test('a DNC contact is blocked (contact_dnc)', async () => {
    await seedOrgSettings(ctx.db);
    const dncContact = await seedContact(ctx.db, lead, [LEAD_NUMBER], { dnc: true, name: 'DoNot' });
    const err = await dialCall(deps, {
      userId: rep,
      leadId: lead,
      contactId: dncContact,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DialBlockedError);
    expect((err as DialBlockedError).reason).toBe('contact_dnc');
    expect(mock.dialCount).toBe(0);
  });

  test('a suppressed phone is blocked (phone_suppressed)', async () => {
    await seedOrgSettings(ctx.db);
    await addPhoneSuppression(ctx.db, { key: '3055550147', source: 'stop_keyword' });
    const err = await dialCall(deps, { userId: rep, leadId: lead, contactId: contact }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DialBlockedError);
    expect((err as DialBlockedError).reason).toBe('phone_suppressed');
    expect(mock.dialCount).toBe(0);
  });
});

describe('validation', () => {
  test('a missing lead is DialLeadNotFoundError', async () => {
    await expect(dialCall(deps, { userId: rep, leadId: NIL })).rejects.toBeInstanceOf(
      DialLeadNotFoundError,
    );
  });

  test('a missing contact is DialContactNotFoundError', async () => {
    await expect(
      dialCall(deps, { userId: rep, leadId: lead, contactId: NIL }),
    ).rejects.toBeInstanceOf(DialContactNotFoundError);
  });

  test('no destination number is a DialValidationError', async () => {
    const noPhone = await seedLead(ctx.db, { name: 'NoPhone' });
    await expect(dialCall(deps, { userId: rep, leadId: noPhone })).rejects.toBeInstanceOf(
      DialValidationError,
    );
  });

  test('no caller id (and no default) is a DialValidationError', async () => {
    const depsNoCaller: DialDeps = { db: ctx.db, provider: mock, now: () => new Date() };
    await expect(
      dialCall(depsNoCaller, { userId: rep, leadId: lead, contactId: contact }),
    ).rejects.toBeInstanceOf(DialValidationError);
  });
});

describe('patchCall', () => {
  test('updates outcome and attaches a rep note (final, not AI) with note_added', async () => {
    await seedOrgSettings(ctx.db);
    const out = await dialCall(deps, { userId: rep, leadId: lead, contactId: contact });
    const res = await patchCall(
      { db: ctx.db, now: () => new Date('2026-07-15T12:05:00.000Z') },
      out.callId,
      { outcome: 'connected', notes: 'Great chat, follow up next week.', actorId: rep },
    );
    expect(res.outcome).toBe('connected');
    expect(res.noteId).not.toBeNull();

    const [call] = await callsFor(ctx.db, lead);
    expect(call?.outcome).toBe('connected');

    const savedNotes = await notesFor(ctx.db, lead);
    expect(savedNotes).toHaveLength(1);
    expect(savedNotes[0]).toMatchObject({ status: 'final', aiGenerated: false });

    const acts = await activitiesFor(ctx.db, lead);
    expect(acts.filter((a) => a.type === 'note_added')).toHaveLength(1);
  });

  test('outcome-only patch writes no note', async () => {
    await seedOrgSettings(ctx.db);
    const out = await dialCall(deps, { userId: rep, leadId: lead, contactId: contact });
    const res = await patchCall({ db: ctx.db, now: () => new Date() }, out.callId, {
      outcome: 'no_answer',
    });
    expect(res.noteId).toBeNull();
    expect(await notesFor(ctx.db, lead)).toHaveLength(0);
  });

  test('a missing call is CallNotFoundError', async () => {
    await expect(
      patchCall({ db: ctx.db, now: () => new Date() }, NIL, { outcome: 'x' }),
    ).rejects.toBeInstanceOf(CallNotFoundError);
  });
});
