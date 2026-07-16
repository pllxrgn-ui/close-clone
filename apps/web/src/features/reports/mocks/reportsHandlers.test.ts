import { beforeEach, describe, expect, test } from 'vitest';
import { ApiError } from '../../../api/errors.ts';
import { server } from '../../../mocks/server.ts';
import { fetchActivityReport, fetchFunnelReport, fetchSequencesReport } from '../api/reports.ts';
import { presetRange } from '../lib/range.ts';
import { reportsHandlers } from './reportsHandlers.ts';
import { reportSeed } from './seed.ts';

// The report handlers live in this feature; install them onto the shared MSW
// server for the duration of each test (setup.ts resets runtime handlers between).
beforeEach(() => server.use(...reportsHandlers));

const q90 = presetRange(90);
const q7 = presetRange(7);

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await promise.catch((e: unknown) => e);
  if (!(err instanceof ApiError)) throw new Error(`expected ApiError, got ${String(err)}`);
  return err;
}

describe('GET /reports/activity', () => {
  test('returns a keyset page of one row per rep', async () => {
    const page = await fetchActivityReport({ from: q90.from, to: q90.to, limit: 500 });
    expect(page.items).toHaveLength(reportSeed.reps.length);
    expect(page.nextCursor).toBeUndefined();
    const first = page.items[0];
    expect(first).toBeDefined();
    // shape check (C7 camelCase, mirrors activityReportRowSchema)
    expect(first).toMatchObject({
      bucket: expect.any(String),
      callsLogged: expect.any(Number),
      callsByOutcome: expect.any(Object),
      talkTimeSeconds: expect.any(Number),
    });
  });

  test('a narrower range visibly re-queries to smaller numbers', async () => {
    const wide = await fetchActivityReport({ from: q90.from, to: q90.to, limit: 500 });
    const narrow = await fetchActivityReport({ from: q7.from, to: q7.to, limit: 500 });
    const sum = (rows: { callsLogged: number }[]): number =>
      rows.reduce((a, r) => a + r.callsLogged, 0);
    expect(sum(narrow.items)).toBeGreaterThan(0);
    expect(sum(narrow.items)).toBeLessThan(sum(wide.items));
  });

  test('a userId filter returns just that rep', async () => {
    const repId = reportSeed.reps[0]?.id ?? '';
    const page = await fetchActivityReport({ from: q90.from, to: q90.to, userId: repId });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.bucket).toBe(repId);
  });

  test('keyset pagination yields a cursor and a distinct next page', async () => {
    const p1 = await fetchActivityReport({ from: q90.from, to: q90.to, limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await fetchActivityReport({
      from: q90.from,
      to: q90.to,
      limit: 2,
      ...(p1.nextCursor !== undefined ? { cursor: p1.nextCursor } : {}),
    });
    expect(p2.items[0]?.bucket).not.toBe(p1.items[0]?.bucket);
  });

  test('missing from/to → VALIDATION_FAILED (C8)', async () => {
    const err = await apiError(
      fetchActivityReport({ from: '', to: '' } as { from: string; to: string }),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.status).toBe(400);
  });

  test('a malformed date → VALIDATION_FAILED', async () => {
    const err = await apiError(fetchActivityReport({ from: '2026-13-40', to: '2026-13-41' }));
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  test('an invalid groupBy → VALIDATION_FAILED', async () => {
    const err = await apiError(
      fetchActivityReport({
        from: q90.from,
        to: q90.to,
        groupBy: 'week' as 'user',
      }),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  test('an inverted range → VALIDATION_FAILED', async () => {
    const err = await apiError(fetchActivityReport({ from: q90.to, to: q90.from }));
    expect(err.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /reports/funnel', () => {
  test('returns per-(currency, stage) rows for every seeded currency', async () => {
    const page = await fetchFunnelReport({ limit: 500 });
    expect(page.items.length).toBeGreaterThan(0);
    const currencies = new Set(page.items.map((r) => r.currency));
    expect(currencies).toEqual(new Set(['USD', 'EUR']));
    expect(page.items[0]).toMatchObject({
      stageLabel: expect.any(String),
      openCount: expect.any(Number),
      openWeightedValueCents: expect.any(Number),
    });
  });

  test('a currency filter isolates that currency', async () => {
    const page = await fetchFunnelReport({ currency: 'usd', limit: 500 });
    expect(page.items.every((r) => r.currency === 'USD')).toBe(true);
  });

  test('from without to → VALIDATION_FAILED', async () => {
    const err = await apiError(fetchFunnelReport({ from: '2026-01-01' }));
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  test('a non-3-letter currency → VALIDATION_FAILED', async () => {
    const err = await apiError(fetchFunnelReport({ currency: 'US' }));
    expect(err.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /reports/sequences', () => {
  test('returns one row per sequence (zero-activity included)', async () => {
    const page = await fetchSequencesReport({ limit: 500 });
    expect(page.items).toHaveLength(reportSeed.sequences.length);
    expect(page.items[0]).toMatchObject({
      sequenceName: expect.any(String),
      sends: expect.any(Number),
      replies: expect.any(Number),
      activeEnrollments: expect.any(Number),
    });
  });

  test('a sequenceId filter isolates one sequence', async () => {
    const id = reportSeed.sequences[0]?.id ?? '';
    const page = await fetchSequencesReport({ sequenceId: id });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.sequenceId).toBe(id);
  });

  test('to without from → VALIDATION_FAILED', async () => {
    const err = await apiError(fetchSequencesReport({ to: '2026-01-01' }));
    expect(err.code).toBe('VALIDATION_FAILED');
  });
});
