import { describe, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server.ts';
import { ApiError } from './errors.ts';
import { getLead, getLeadTimeline, listLeads } from './leads.ts';
import { previewSmartView } from './smartViews.ts';
import { search } from './search.ts';

describe('leads endpoints', () => {
  test('lists a keyset page with a nextCursor', async () => {
    const page = await listLeads({ limit: 50 });
    expect(page.items).toHaveLength(50);
    expect(typeof page.nextCursor).toBe('string');
  });

  test('keyset pages do not overlap and advance', async () => {
    const first = await listLeads({ limit: 40 });
    const cursor = first.nextCursor;
    if (!cursor) throw new Error('expected a nextCursor on the first page');
    const second = await listLeads({ limit: 40, cursor });
    expect(second.items.length).toBeGreaterThan(0);
    const firstIds = new Set(first.items.map((l) => l.id));
    expect(second.items.some((l) => firstIds.has(l.id))).toBe(false);
  });

  test('gets a single lead by id', async () => {
    const page = await listLeads({ limit: 1 });
    const lead = page.items.at(0);
    if (!lead) throw new Error('fixture must contain at least one lead');
    const got = await getLead(lead.id);
    expect(got.id).toBe(lead.id);
    expect(got.name).toBe(lead.name);
  });

  // failure path: unknown id → typed NOT_FOUND
  test('getLead(unknown) throws ApiError NOT_FOUND', async () => {
    const err: unknown = await getLead('00000000-0000-4000-8000-000000000000').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    if (err instanceof ApiError) {
      expect(err.code).toBe('NOT_FOUND');
      expect(err.status).toBe(404);
    }
  });

  test('reads a lead timeline page (C4 events, newest first)', async () => {
    const page = await listLeads({ limit: 1 });
    const lead = page.items.at(0);
    if (!lead) throw new Error('fixture must contain at least one lead');
    const timeline = await getLeadTimeline(lead.id, { limit: 5 });
    expect(timeline.items.length).toBeGreaterThan(0);
    for (const event of timeline.items) {
      expect(event.leadId).toBe(lead.id);
      expect(typeof event.occurredAt).toBe('string');
    }
  });
});

describe('search endpoint', () => {
  test('returns hits for a matching query', async () => {
    const res = await search('Labs');
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items[0]?.type).toBeDefined();
  });

  // failure path: empty query → VALIDATION_FAILED
  test('empty query throws ApiError VALIDATION_FAILED', async () => {
    const err: unknown = await search('   ').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    if (err instanceof ApiError) {
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.status).toBe(400);
    }
  });
});

describe('smart-view preview', () => {
  test('valid DSL returns a first page + count-estimate', async () => {
    const res = await previewSmartView({ dsl: 'dnc = true' });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.countEstimate).toBeGreaterThan(0);
  });

  // failure path: invalid DSL → VALIDATION_FAILED with a position detail
  test('invalid DSL throws ApiError VALIDATION_FAILED', async () => {
    const err: unknown = await previewSmartView({ dsl: 'status ~~ "x"' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    if (err instanceof ApiError) {
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.details).toBeTruthy();
    }
  });
});

describe('error mapping', () => {
  // failure path: non-JSON 5xx body still yields a typed INTERNAL ApiError
  test('non-JSON server error maps to INTERNAL', async () => {
    server.use(
      http.get('*/api/v1/leads/:id', () => new HttpResponse('upstream exploded', { status: 500 })),
    );
    const err: unknown = await getLead('11111111-1111-4111-8111-111111111111').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    if (err instanceof ApiError) {
      expect(err.code).toBe('INTERNAL');
      expect(err.status).toBe(500);
    }
  });
});
