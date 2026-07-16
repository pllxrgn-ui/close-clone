import { describe, expect, test } from 'vitest';
import { channelLabel, formatDelay, relativeTime } from './format.ts';

describe('formatDelay', () => {
  test('zero and negative render as Immediately', () => {
    expect(formatDelay(0)).toBe('Immediately');
    expect(formatDelay(-4)).toBe('Immediately');
  });

  test('whole days', () => {
    expect(formatDelay(24)).toBe('1 day');
    expect(formatDelay(48)).toBe('2 days');
    expect(formatDelay(168)).toBe('7 days');
  });

  test('sub-day hours', () => {
    expect(formatDelay(6)).toBe('6 hours');
    expect(formatDelay(1)).toBe('1 hour');
  });

  test('mixed days and hours', () => {
    expect(formatDelay(50)).toBe('2 days 2 hours');
  });
});

describe('channelLabel', () => {
  test('maps step types', () => {
    expect(channelLabel('email')).toBe('Email');
    expect(channelLabel('call_task')).toBe('Call task');
    expect(channelLabel('sms')).toBe('SMS');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  test('buckets by magnitude', () => {
    expect(relativeTime('2026-07-15T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-07-15T11:45:00.000Z', now)).toBe('15m ago');
    expect(relativeTime('2026-07-15T09:00:00.000Z', now)).toBe('3h ago');
    expect(relativeTime('2026-07-13T12:00:00.000Z', now)).toBe('2d ago');
    expect(relativeTime('2026-05-15T12:00:00.000Z', now)).toBe('2mo ago');
  });

  test('invalid input is empty', () => {
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});
