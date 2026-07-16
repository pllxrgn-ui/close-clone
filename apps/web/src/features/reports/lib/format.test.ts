import { describe, expect, test } from 'vitest';
import {
  formatDateRangeLabel,
  formatInt,
  formatMoneyCents,
  formatPercent,
  formatTalkTime,
  meterTone,
  replyRatePercent,
} from './format.ts';

describe('formatInt', () => {
  test('groups thousands', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatInt(12842)).toBe('12,842');
    expect(formatInt(1000000)).toBe('1,000,000');
  });
});

describe('formatMoneyCents', () => {
  test('renders whole-unit currency from cents', () => {
    expect(formatMoneyCents(1_250_000, 'USD')).toBe('$12,500');
    expect(formatMoneyCents(0, 'USD')).toBe('$0');
  });

  test('groups by the opportunity currency (never sums across)', () => {
    // EUR renders with the euro symbol; the exact glyph placement is Intl's.
    expect(formatMoneyCents(500_000, 'EUR')).toContain('5,000');
    expect(formatMoneyCents(500_000, 'EUR')).toMatch(/€|EUR/);
  });

  test('falls back to a grouped integer + code for a malformed currency', () => {
    // A non-3-letter code makes Intl throw; the formatter degrades instead of crashing.
    expect(formatMoneyCents(100_000, 'US')).toBe('1,000 US');
  });
});

describe('formatTalkTime', () => {
  test.each([
    [0, '0:00'],
    [59, '0:00'],
    [60, '0:01'],
    [3725, '1:02'],
    [216000, '60:00'],
  ])('%d seconds → %s (H:MM)', (secs, expected) => {
    expect(formatTalkTime(secs)).toBe(expected);
  });

  test('clamps negative / non-finite to 0:00', () => {
    expect(formatTalkTime(-10)).toBe('0:00');
    expect(formatTalkTime(Number.NaN)).toBe('0:00');
  });
});

describe('replyRatePercent + meterTone', () => {
  test('computes the rate as a percentage', () => {
    expect(replyRatePercent(120, 27)).toBeCloseTo(22.5, 5);
    expect(replyRatePercent(80, 9)).toBeCloseTo(11.25, 5);
    expect(replyRatePercent(64, 2)).toBeCloseTo(3.125, 5);
  });

  test('zero sends is 0% (no divide-by-zero)', () => {
    expect(replyRatePercent(0, 0)).toBe(0);
  });

  test('bands: >=15 high (jade), 5-15 mid (amber), <5 low (dim)', () => {
    expect(meterTone(22.5)).toBe('high');
    expect(meterTone(15)).toBe('high');
    expect(meterTone(11.25)).toBe('mid');
    expect(meterTone(5)).toBe('mid');
    expect(meterTone(3.125)).toBe('low');
    expect(meterTone(0)).toBe('low');
  });
});

describe('formatPercent', () => {
  test('fixed precision', () => {
    expect(formatPercent(22.5)).toBe('22.5%');
    expect(formatPercent(3.125, 2)).toBe('3.13%');
    expect(formatPercent(0)).toBe('0.0%');
  });
});

describe('formatDateRangeLabel', () => {
  test('same-year range omits the year on the left bound', () => {
    expect(formatDateRangeLabel('2026-06-16', '2026-07-15')).toBe('Jun 16 – Jul 15, 2026');
  });

  test('cross-year range keeps both years', () => {
    expect(formatDateRangeLabel('2025-12-30', '2026-01-05')).toBe('Dec 30, 2025 – Jan 5, 2026');
  });
});
