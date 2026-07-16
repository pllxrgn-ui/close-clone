import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { renderVoiceTwiml, resolveInboundRouting } from './routing.ts';
import { seedContact, seedLead, seedUser } from './test-helpers.ts';

/**
 * Inbound-call routing (task 3b acceptance: owner → ring-group → voicemail). The
 * tiering decision is tested against seeded owners/reps; the TwiML render is
 * checked separately so the XML never gates the routing logic.
 */

const CALLER = '+13055550147';

let ctx: TestDb;

beforeEach(async () => {
  ctx = await createTestDb();
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('resolveInboundRouting', () => {
  test('routes to the lead owner first, then the ring group, then voicemail', async () => {
    const owner = await seedUser(ctx.db, { name: 'Aowner' });
    const rep2 = await seedUser(ctx.db, { name: 'Brep' });
    const rep3 = await seedUser(ctx.db, { name: 'Crep' });
    const lead = await seedLead(ctx.db, { name: 'Acme', ownerId: owner });
    await seedContact(ctx.db, lead, [CALLER]);

    const plan = await resolveInboundRouting(ctx.db, CALLER);
    expect(plan.primary).toBe('owner');
    expect(plan.leadId).toBe(lead);
    expect(plan.tiers[0]).toEqual({ kind: 'owner', userId: owner });
    // Ring group = the other active users (owner excluded), name-ordered.
    expect(plan.tiers.slice(1)).toEqual([
      { kind: 'ring_group', userId: rep2 },
      { kind: 'ring_group', userId: rep3 },
    ]);
    expect(plan.voicemail).toBe(true);
  });

  test('falls back to the ring group when the owner is inactive', async () => {
    const owner = await seedUser(ctx.db, { name: 'Aowner', isActive: false });
    const rep2 = await seedUser(ctx.db, { name: 'Brep' });
    const lead = await seedLead(ctx.db, { name: 'Acme', ownerId: owner });
    await seedContact(ctx.db, lead, [CALLER]);

    const plan = await resolveInboundRouting(ctx.db, CALLER);
    expect(plan.primary).toBe('ring_group');
    expect(plan.tiers.every((t) => t.kind === 'ring_group')).toBe(true);
    expect(plan.tiers.map((t) => t.userId)).toEqual([rep2]);
  });

  test('an unknown number still reaches the ring group then voicemail', async () => {
    const rep = await seedUser(ctx.db, { name: 'Solo' });
    const plan = await resolveInboundRouting(ctx.db, '+19998887777');
    expect(plan.leadId).toBeNull();
    expect(plan.contactId).toBeNull();
    expect(plan.primary).toBe('ring_group');
    expect(plan.tiers.map((t) => t.userId)).toEqual([rep]);
  });

  test('voicemail-only when there is nobody to ring', async () => {
    const owner = await seedUser(ctx.db, { name: 'Aowner' });
    const lead = await seedLead(ctx.db, { name: 'Acme', ownerId: owner });
    await seedContact(ctx.db, lead, [CALLER]);
    // Deactivate everyone → no owner, empty ring group.
    await ctx.db.update(users).set({ isActive: false }).where(eq(users.id, owner));

    const plan = await resolveInboundRouting(ctx.db, CALLER);
    expect(plan.primary).toBe('voicemail');
    expect(plan.tiers).toHaveLength(0);
    expect(plan.voicemail).toBe(true);
  });
});

describe('renderVoiceTwiml', () => {
  test('renders owner + ring-group dials and a voicemail record verb', () => {
    const xml = renderVoiceTwiml(
      {
        leadId: 'l1',
        contactId: 'c1',
        primary: 'owner',
        tiers: [
          { kind: 'owner', userId: 'owner-1' },
          { kind: 'ring_group', userId: 'rep-2' },
          { kind: 'ring_group', userId: 'rep-3' },
        ],
        voicemail: true,
      },
      { voicemailActionUrl: 'https://switchboard.test/wh/twilio/status' },
    );
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<Client>owner-1</Client>');
    expect(xml).toContain('<Client>rep-2</Client><Client>rep-3</Client>');
    expect(xml).toContain('recordingStatusCallback="https://switchboard.test/wh/twilio/status"');
    expect(xml).toContain('<Record');
    // Owner dial precedes the ring-group dial precedes the voicemail.
    expect(xml.indexOf('owner-1')).toBeLessThan(xml.indexOf('rep-2'));
    expect(xml.indexOf('rep-2')).toBeLessThan(xml.indexOf('<Record'));
  });

  test('renders a voicemail-only response when there are no dial targets', () => {
    const xml = renderVoiceTwiml(
      { leadId: null, contactId: null, primary: 'voicemail', tiers: [], voicemail: true },
      { voicemailActionUrl: 'https://switchboard.test/wh/twilio/status' },
    );
    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('<Record');
  });
});
