import { describe, expect, test } from 'vitest';
import { formatCloseDate, isPastDate, monogram, todayIsoUtc } from './format.ts';

describe('monogram', () => {
  test('takes initials of the first two words', () => {
    expect(monogram('Ada Okafor')).toBe('AO');
    expect(monogram('  priya   menon ')).toBe('PM');
  });

  test('falls back to the first two letters of a single word', () => {
    expect(monogram('Cher')).toBe('CH');
  });

  test('never throws on an empty name', () => {
    expect(monogram('   ')).toBe('?');
  });
});

describe('isPastDate', () => {
  const now = new Date('2026-07-15T17:00:00.000Z');

  test('a date before today (UTC) is past', () => {
    expect(isPastDate('2026-07-14', now)).toBe(true);
  });

  test('today itself is not past (due today ≠ overdue)', () => {
    expect(isPastDate('2026-07-15', now)).toBe(false);
  });

  test('a future date is not past', () => {
    expect(isPastDate('2026-08-01', now)).toBe(false);
  });

  test('a null close date is never past', () => {
    expect(isPastDate(null, now)).toBe(false);
  });

  test('compares on the UTC calendar date regardless of intra-day time', () => {
    // 23:59Z on the 15th is still "today", so the 15th is not yet past.
    expect(isPastDate('2026-07-15', new Date('2026-07-15T23:59:59.000Z'))).toBe(false);
    expect(todayIsoUtc(new Date('2026-07-15T23:59:59.000Z'))).toBe('2026-07-15');
  });
});

describe('formatCloseDate', () => {
  test('renders a compact month + day', () => {
    expect(formatCloseDate('2026-07-15')).toBe('Jul 15');
    expect(formatCloseDate('2026-01-03')).toBe('Jan 3');
  });

  test('handles a null date', () => {
    expect(formatCloseDate(null)).toBe('—');
  });

  test('falls back to the raw string on a malformed value', () => {
    expect(formatCloseDate('not-a-date')).toBe('not-a-date');
  });
});
