import { describe, expect, test } from 'vitest';
import { leadSchema, opportunitySchema, userSchema } from './domain.ts';

describe('domain DTOs (CONTRACTS §C1)', () => {
  test('userSchema parses a valid user and rejects a bad role', () => {
    const user = userSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'a@b.test',
      name: 'A',
      role: 'admin',
      idpSubject: 's',
      isActive: true,
      timezone: 'UTC',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(user.role).toBe('admin');
    expect(() => userSchema.parse({ ...user, role: 'superadmin' })).toThrow();
  });

  test('leadSchema allows nullable denorm columns', () => {
    const lead = leadSchema.parse({
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Acme',
      url: null,
      description: null,
      statusId: null,
      ownerId: null,
      custom: {},
      lastContactedAt: null,
      lastInboundAt: null,
      nextTaskDueAt: null,
      lastCallAt: null,
      lastEmailAt: null,
      lastSmsAt: null,
      dnc: false,
      deletedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(lead.name).toBe('Acme');
  });

  test('opportunitySchema enforces confidence 0..100', () => {
    const base = {
      id: '33333333-3333-3333-3333-333333333333',
      leadId: '22222222-2222-2222-2222-222222222222',
      contactId: null,
      valueCents: 1000,
      currency: 'USD',
      stageId: null,
      confidence: 50,
      closeDate: null,
      ownerId: null,
      status: 'active' as const,
      note: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(opportunitySchema.parse(base).confidence).toBe(50);
    expect(() => opportunitySchema.parse({ ...base, confidence: 101 })).toThrow();
  });
});
