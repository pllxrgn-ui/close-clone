import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Opportunity, OpportunityStage } from '@switchboard/shared';
import { ApiError, apiRequest } from '../../../api/index.ts';
import type { Page } from '../../../api/index.ts';
import { db } from '../../../mocks/fixtures.ts';
import { server } from '../../../mocks/server.ts';
import { resetStore } from '../data/store.ts';
import { pipelineHandlers } from './pipelineHandlers.ts';

function stage(id: string, label: string, sortOrder: number): OpportunityStage {
  return {
    id,
    label,
    sortOrder,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
function opp(id: string, stageId: string, currency: string): Opportunity {
  return {
    id,
    leadId: 'l1',
    contactId: null,
    valueCents: 100_00,
    currency,
    stageId,
    confidence: 40,
    closeDate: '2026-08-01',
    ownerId: null,
    status: 'active',
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const STAGES = [
  stage('disc', 'Discovery', 0),
  stage('prop', 'Proposal', 1),
  stage('won', 'Closed Won', 2),
];

beforeEach(() => {
  resetStore({
    opportunities: [opp('o1', 'disc', 'USD'), opp('o2', 'prop', 'EUR'), opp('o3', 'won', 'USD')],
    stages: STAGES,
  });
  // Prepend the board handlers so they win over the leads-detail /opportunities
  // handler already in the shared server (mirrors the production merge order).
  server.use(...pipelineHandlers);
});
afterEach(() => {
  resetStore();
});

describe('GET /opportunity-stages', () => {
  test('returns the board stages', async () => {
    const stages = await apiRequest<OpportunityStage[]>('/opportunity-stages');
    expect(stages.map((s) => s.id)).toEqual(['disc', 'prop', 'won']);
  });
});

describe('GET /opportunities', () => {
  test('lists every deal as a keyset page (no leadId)', async () => {
    const page = await apiRequest<Page<Opportunity>>('/opportunities');
    expect(page.items.map((o) => o.id)).toEqual(['o1', 'o2', 'o3']);
    expect(page.nextCursor).toBeUndefined();
  });

  test('paginates with limit + cursor', async () => {
    const first = await apiRequest<Page<Opportunity>>('/opportunities', { query: { limit: 2 } });
    expect(first.items.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(first.nextCursor).toBeDefined();

    const second = await apiRequest<Page<Opportunity>>('/opportunities', {
      query: { limit: 2, cursor: first.nextCursor },
    });
    expect(second.items.map((o) => o.id)).toEqual(['o3']);
    expect(second.nextCursor).toBeUndefined();
  });

  test('falls through to the leads handler when leadId is present', async () => {
    // A per-lead read is owned by leadDetailHandlers, which returns a bare array
    // (not the board envelope). Reaching it proves the board GET returned
    // undefined for the leadId case.
    const leadId = db.opportunities[0]!.leadId;
    const perLead = await apiRequest<Opportunity[]>('/opportunities', { query: { leadId } });
    expect(Array.isArray(perLead)).toBe(true);
    expect(perLead.every((o) => o.leadId === leadId)).toBe(true);

    const board = await apiRequest<Page<Opportunity>>('/opportunities');
    expect(Array.isArray(board)).toBe(false);
    expect(board.items).toBeDefined();
  });
});

describe('PATCH /opportunities/:id', () => {
  test('moves a deal to a new stage + status and persists it', async () => {
    const updated = await apiRequest<Opportunity>('/opportunities/o1', {
      method: 'PATCH',
      body: { stageId: 'won', status: 'won' },
    });
    expect(updated.stageId).toBe('won');
    expect(updated.status).toBe('won');

    const page = await apiRequest<Page<Opportunity>>('/opportunities');
    expect(page.items.find((o) => o.id === 'o1')?.stageId).toBe('won');
  });

  test('rejects an unknown opportunity with 404 NOT_FOUND', async () => {
    await expect(
      apiRequest('/opportunities/ghost', { method: 'PATCH', body: { stageId: 'won' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  test('rejects an unknown stageId with 400 VALIDATION_FAILED', async () => {
    await expect(
      apiRequest('/opportunities/o1', { method: 'PATCH', body: { stageId: 'nope' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  });

  test('rejects an invalid status with 400 VALIDATION_FAILED', async () => {
    await expect(
      apiRequest('/opportunities/o1', { method: 'PATCH', body: { status: 'archived' } }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test('rejects an empty patch with 400', async () => {
    await expect(
      apiRequest('/opportunities/o1', { method: 'PATCH', body: {} }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
