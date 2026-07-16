import { describe, expect, test } from 'vitest';
import {
  MAX_RANGE_DAYS,
  REPORT_NOW,
  ReportRangeError,
  parseUtcDateMs,
  presetByKey,
  presetRange,
  rangeForKey,
  resolveRange,
  toUtcDateString,
} from './range.ts';

describe('presetRange', () => {
  test('spans exactly `days` calendar days, inclusive of `to`', () => {
    // REPORT_NOW is 2026-07-15 (UTC).
    expect(presetRange(7)).toEqual({ from: '2026-07-09', to: '2026-07-15' });
    expect(presetRange(30)).toEqual({ from: '2026-06-16', to: '2026-07-15' });
    expect(presetRange(90)).toEqual({ from: '2026-04-17', to: '2026-07-15' });
  });

  test('is anchored to REPORT_NOW by default but takes an explicit now', () => {
    const now = new Date('2026-01-10T23:30:00Z');
    expect(presetRange(1, now)).toEqual({ from: '2026-01-10', to: '2026-01-10' });
    expect(presetRange(3, now)).toEqual({ from: '2026-01-08', to: '2026-01-10' });
  });

  test('REPORT_NOW is the fixed demo anchor', () => {
    expect(toUtcDateString(REPORT_NOW)).toBe('2026-07-15');
  });
});

describe('presetByKey / rangeForKey', () => {
  test('resolves known keys and falls back to the default (30d) for unknown', () => {
    expect(presetByKey('7d').days).toBe(7);
    expect(presetByKey('nonsense').days).toBe(30);
  });

  test('rangeForKey matches the preset span', () => {
    expect(rangeForKey('90d')).toEqual(presetRange(90));
  });
});

describe('parseUtcDateMs', () => {
  test('parses a real calendar date at UTC midnight', () => {
    expect(parseUtcDateMs('2026-07-15')).toBe(Date.UTC(2026, 6, 15));
  });

  test.each(['2026-13-01', '2026-02-30', '2026-7-1', 'not-a-date', ''])(
    'rejects the non-date %j',
    (bad) => {
      expect(() => parseUtcDateMs(bad)).toThrow(ReportRangeError);
    },
  );
});

describe('resolveRange', () => {
  test('produces a half-open window where `to` is fully included', () => {
    const r = resolveRange('2026-07-01', '2026-07-07');
    expect(r.fromMs).toBe(Date.UTC(2026, 6, 1));
    expect(r.toExclusiveMs).toBe(Date.UTC(2026, 6, 8));
    expect(r.fromDate).toBe('2026-07-01');
    expect(r.toExclusiveDate).toBe('2026-07-08');
  });

  test('a single-day range still includes the whole day', () => {
    const r = resolveRange('2026-07-15', '2026-07-15');
    expect(r.toExclusiveMs - r.fromMs).toBe(86_400_000);
  });

  test('rejects an inverted range', () => {
    expect(() => resolveRange('2026-07-10', '2026-07-01')).toThrow(/on or before/);
  });

  test(`rejects a range wider than ${MAX_RANGE_DAYS} days`, () => {
    expect(() => resolveRange('2025-01-01', '2026-12-31')).toThrow(/exceeds/);
  });

  test('accepts a range exactly at the cap', () => {
    // 2025-01-01 → 2026-01-02 is 366 days apart.
    expect(() => resolveRange('2025-01-01', '2026-01-02')).not.toThrow();
  });
});
