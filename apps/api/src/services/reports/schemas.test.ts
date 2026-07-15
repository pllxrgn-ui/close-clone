import { describe, expect, test } from 'vitest';

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
  ReportRangeError,
  activityQuerySchema,
  buildPage,
  clampLimit,
  funnelQuerySchema,
  resolveRange,
  sequencesQuerySchema,
} from './schemas.ts';

/**
 * Task 4g — pure contract logic: UTC date-range resolution + its failure paths,
 * limit clamping, keyset page assembly, and query-string validation. No DB.
 */

describe('resolveRange — UTC anchoring', () => {
  test('resolves to a half-open [from 00:00Z, to+1day 00:00Z) range', () => {
    expect(resolveRange('2026-01-01', '2026-01-31')).toEqual({
      fromTs: '2026-01-01T00:00:00.000Z',
      toExclusiveTs: '2026-02-01T00:00:00.000Z',
    });
  });

  test('a single-day range spans exactly one UTC day', () => {
    expect(resolveRange('2026-03-15', '2026-03-15')).toEqual({
      fromTs: '2026-03-15T00:00:00.000Z',
      toExclusiveTs: '2026-03-16T00:00:00.000Z',
    });
  });

  test('crosses a leap day correctly', () => {
    expect(resolveRange('2028-02-28', '2028-02-29').toExclusiveTs).toBe('2028-03-01T00:00:00.000Z');
  });

  test('exactly MAX_RANGE_DAYS apart is allowed', () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(from.getTime() + MAX_RANGE_DAYS * 86_400_000);
    const toStr = to.toISOString().slice(0, 10);
    expect(() => resolveRange('2026-01-01', toStr)).not.toThrow();
  });
});

describe('resolveRange — failure paths (→ ReportRangeError → VALIDATION_FAILED)', () => {
  test('inverted range throws', () => {
    expect(() => resolveRange('2026-02-01', '2026-01-01')).toThrow(ReportRangeError);
  });

  test('span over the cap throws', () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(from.getTime() + (MAX_RANGE_DAYS + 1) * 86_400_000);
    expect(() => resolveRange('2026-01-01', to.toISOString().slice(0, 10))).toThrow(
      ReportRangeError,
    );
  });

  test('a non-calendar date (Feb 30) throws rather than silently normalising', () => {
    expect(() => resolveRange('2026-02-30', '2026-03-01')).toThrow(ReportRangeError);
  });

  test('a bogus month throws', () => {
    expect(() => resolveRange('2026-13-01', '2026-13-02')).toThrow(ReportRangeError);
  });
});

describe('clampLimit', () => {
  test.each([
    [undefined, DEFAULT_LIMIT],
    [0, 1],
    [-5, 1],
    [10, 10],
    [MAX_LIMIT + 100, MAX_LIMIT],
    [3.9, 3],
    [Number.NaN, DEFAULT_LIMIT],
  ])('clampLimit(%s) === %s', (input, expected) => {
    expect(clampLimit(input)).toBe(expected);
  });
});

describe('buildPage — keyset assembly', () => {
  test('no extra row → no nextCursor', () => {
    const page = buildPage([{ id: 'a' }, { id: 'b' }], 5, (r) => r.id);
    expect(page).toEqual({ items: [{ id: 'a' }, { id: 'b' }] });
    expect(page.nextCursor).toBeUndefined();
  });

  test('an extra row → trimmed items + nextCursor from the last kept row', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const page = buildPage(rows, 2, (r) => r.id);
    expect(page.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(page.nextCursor).toBe('b');
  });

  test('empty input → empty page', () => {
    expect(buildPage<{ id: string }>([], 10, (r) => r.id)).toEqual({ items: [] });
  });
});

describe('activityQuerySchema', () => {
  test('defaults groupBy to user and coerces limit', () => {
    const parsed = activityQuerySchema.parse({ from: '2026-01-01', to: '2026-01-31', limit: '25' });
    expect(parsed.groupBy).toBe('user');
    expect(parsed.limit).toBe(25);
  });

  test('rejects a missing from/to', () => {
    expect(activityQuerySchema.safeParse({ to: '2026-01-31' }).success).toBe(false);
  });

  test('rejects an unknown groupBy', () => {
    const r = activityQuerySchema.safeParse({
      from: '2026-01-01',
      to: '2026-01-02',
      groupBy: 'week',
    });
    expect(r.success).toBe(false);
  });

  test('rejects a non-uuid userId', () => {
    const r = activityQuerySchema.safeParse({
      from: '2026-01-01',
      to: '2026-01-02',
      userId: 'nope',
    });
    expect(r.success).toBe(false);
  });

  test.each(['0', '-1', '99999', 'abc', '1.5'])('rejects limit=%s', (limit) => {
    const r = activityQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-02', limit });
    expect(r.success).toBe(false);
  });
});

describe('funnelQuerySchema / sequencesQuerySchema — from/to togetherness', () => {
  test('funnel accepts neither from nor to', () => {
    expect(funnelQuerySchema.safeParse({}).success).toBe(true);
  });

  test('funnel rejects from without to', () => {
    expect(funnelQuerySchema.safeParse({ from: '2026-01-01' }).success).toBe(false);
  });

  test('funnel rejects a non-3-char currency', () => {
    expect(funnelQuerySchema.safeParse({ currency: 'US' }).success).toBe(false);
  });

  test('sequences rejects to without from', () => {
    expect(sequencesQuerySchema.safeParse({ to: '2026-01-31' }).success).toBe(false);
  });

  test('sequences accepts a bare sequenceId', () => {
    const r = sequencesQuerySchema.safeParse({
      sequenceId: '00000000-0000-4000-8000-000000000001',
    });
    expect(r.success).toBe(true);
  });
});
