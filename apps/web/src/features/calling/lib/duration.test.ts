import { describe, expect, test } from 'vitest';
import { elapsedSeconds, formatCallDuration } from './duration.ts';

describe('formatCallDuration', () => {
  test.each([
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [65, '1:05'],
    [754, '12:34'],
    [3600, '1:00:00'],
    [3723, '1:02:03'],
    [36_000, '10:00:00'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatCallDuration(seconds)).toBe(expected);
  });

  test('clamps negatives and non-finite input to 0:00', () => {
    expect(formatCallDuration(-5)).toBe('0:00');
    expect(formatCallDuration(Number.NaN)).toBe('0:00');
    expect(formatCallDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
  });

  test('floors fractional seconds (a tick mid-second reads down)', () => {
    expect(formatCallDuration(9.9)).toBe('0:09');
  });
});

describe('elapsedSeconds', () => {
  test('whole seconds between two epoch marks', () => {
    expect(elapsedSeconds(1000, 6000)).toBe(5);
    expect(elapsedSeconds(1000, 6999)).toBe(5);
  });

  test('never goes negative when the clock appears to run backwards', () => {
    expect(elapsedSeconds(6000, 1000)).toBe(0);
  });
});
