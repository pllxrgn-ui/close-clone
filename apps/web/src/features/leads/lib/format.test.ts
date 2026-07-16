import { describe, expect, test } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatDayLabel,
  formatMoneyCents,
  formatMoneyCentsCompact,
  formatRelativeTime,
  localDayKey,
  truncate,
} from './format.ts';

// A fixed reference instant; helpers take `now` explicitly so these are stable.
const NOW = new Date('2026-07-15T17:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  test('sub-minute reads "now"', () => {
    expect(formatRelativeTime(ago(30_000), NOW)).toBe('now');
    expect(formatRelativeTime(ahead(20_000), NOW)).toBe('now');
  });

  test('minutes/hours/days/weeks in the past render bare', () => {
    expect(formatRelativeTime(ago(5 * MIN), NOW)).toBe('5m');
    expect(formatRelativeTime(ago(3 * HOUR), NOW)).toBe('3h');
    expect(formatRelativeTime(ago(2 * DAY), NOW)).toBe('2d');
    expect(formatRelativeTime(ago(2 * 7 * DAY), NOW)).toBe('2w');
  });

  test('future timestamps carry a leading "in"', () => {
    expect(formatRelativeTime(ahead(3 * HOUR), NOW)).toBe('in 3h');
    expect(formatRelativeTime(ahead(2 * DAY), NOW)).toBe('in 2d');
  });

  test('beyond four weeks falls back to an absolute date', () => {
    // Same calendar year → no year suffix.
    expect(formatRelativeTime('2026-02-04T12:00:00.000Z', NOW)).toBe('Feb 4');
    // Different year → year suffix.
    expect(formatRelativeTime('2024-02-04T12:00:00.000Z', NOW)).toBe('Feb 4, 2024');
  });

  test('failure path: an unparseable date yields a dash', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('—');
  });
});

describe('formatDayLabel', () => {
  // Local-constructed dates keep the calendar-day comparison tz-independent.
  const localNow = new Date(2026, 6, 15, 12, 0, 0);
  const at = (y: number, m: number, d: number, h = 9): string =>
    new Date(y, m, d, h).toISOString();

  test('today / yesterday / weekday / absolute buckets', () => {
    expect(formatDayLabel(at(2026, 6, 15), localNow)).toBe('Today');
    expect(formatDayLabel(at(2026, 6, 14), localNow)).toBe('Yesterday');
    // 3 days ago (Jul 12, 2026 is a Sunday) → weekday name.
    expect(formatDayLabel(at(2026, 6, 12), localNow)).toBe('Sunday');
    // Older than a week, same year → absolute short date.
    expect(formatDayLabel(at(2026, 3, 2), localNow)).toBe('Apr 2');
  });

  test('failure path: bad input yields a dash', () => {
    expect(formatDayLabel('nonsense', localNow)).toBe('—');
  });
});

describe('localDayKey', () => {
  test('is a zero-padded local Y-M-D', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23).toISOString())).toBe('2026-01-05');
  });
  test('groups two instants on the same local day identically', () => {
    const a = localDayKey(new Date(2026, 6, 15, 8).toISOString());
    const b = localDayKey(new Date(2026, 6, 15, 20).toISOString());
    expect(a).toBe(b);
  });
});

describe('money', () => {
  test('whole-dollar formatting from integer cents', () => {
    expect(formatMoneyCents(1_250_000)).toBe('$12,500');
    expect(formatMoneyCents(0)).toBe('$0');
  });
  test('compact formatting for dense cells', () => {
    expect(formatMoneyCentsCompact(1_250_000)).toBe('$12.5K');
    expect(formatMoneyCentsCompact(2_400_000_00)).toBe('$2.4M');
  });
});

describe('date + truncate', () => {
  test('formatDate is a short date with year', () => {
    expect(formatDate('2026-03-04')).toBe('Mar 4, 2026');
  });
  test('formatDateTime returns a dash on bad input', () => {
    expect(formatDateTime('bad')).toBe('—');
  });
  test('truncate leaves short strings intact and ellipsizes long ones', () => {
    expect(truncate('short', 20)).toBe('short');
    const out = truncate('the quick brown fox jumps over', 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
  });
});
