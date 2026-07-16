import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { contacts } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { phoneMatchKey, resolveContactByPhone } from './phone.ts';
import { seedContact, seedLead } from './test-helpers.ts';

/**
 * Phone helpers (task 3b): the trailing-10-digit match key and contact resolution
 * that the ingress/dial paths key off. Matching is formatting-insensitive and
 * skips soft-deleted contacts/leads.
 */

let ctx: TestDb;

beforeEach(async () => {
  ctx = await createTestDb();
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('phoneMatchKey', () => {
  test('reduces any format to the trailing 10 digits', () => {
    expect(phoneMatchKey('+13055550147')).toBe('3055550147');
    expect(phoneMatchKey('(305) 555-0147')).toBe('3055550147');
    expect(phoneMatchKey('305.555.0147')).toBe('3055550147');
    expect(phoneMatchKey('3055550147')).toBe('3055550147');
  });

  test('returns empty for a number with fewer than 10 digits', () => {
    expect(phoneMatchKey('555-0147')).toBe('');
    expect(phoneMatchKey('')).toBe('');
  });
});

describe('resolveContactByPhone', () => {
  test('matches a seeded contact regardless of the incoming format', async () => {
    const lead = await seedLead(ctx.db, { name: 'Acme' });
    const contact = await seedContact(ctx.db, lead, ['+13055550147']);

    for (const incoming of ['+13055550147', '3055550147', '+1 (305) 555-0147']) {
      const match = await resolveContactByPhone(ctx.db, incoming);
      expect(match).toEqual({ leadId: lead, contactId: contact });
    }
  });

  test('returns null for an unknown number', async () => {
    const lead = await seedLead(ctx.db, { name: 'Acme' });
    await seedContact(ctx.db, lead, ['+13055550147']);
    expect(await resolveContactByPhone(ctx.db, '+19998887777')).toBeNull();
    expect(await resolveContactByPhone(ctx.db, '123')).toBeNull();
  });

  test('skips soft-deleted contacts and leads', async () => {
    const lead = await seedLead(ctx.db, { name: 'Acme' });
    await seedContact(ctx.db, lead, ['+13055550147']);
    // Soft-delete the contact → no match.
    await ctx.db
      .update(contacts)
      .set({ deletedAt: sql`now()` })
      .where(eq(contacts.leadId, lead));
    expect(await resolveContactByPhone(ctx.db, '+13055550147')).toBeNull();
  });
});
