import { describe, expect, test } from 'vitest';

import {
  DEFAULT_BACKOFF,
  backoffCeilingMs,
  isDeadLettered,
  nextRetryDelayMs,
  type BackoffConfig,
} from './backoff.ts';

/** Task 5c — retry schedule. Exact ceiling + deterministic jitter + dead-letter. */

const CFG: BackoffConfig = { baseMs: 1_000, factor: 2, maxMs: 30_000, maxAttempts: 6 };

describe('backoffCeilingMs — exact truncated-exponential schedule', () => {
  test('doubles each attempt then caps at maxMs', () => {
    expect(backoffCeilingMs(1, CFG)).toBe(1_000);
    expect(backoffCeilingMs(2, CFG)).toBe(2_000);
    expect(backoffCeilingMs(3, CFG)).toBe(4_000);
    expect(backoffCeilingMs(4, CFG)).toBe(8_000);
    expect(backoffCeilingMs(5, CFG)).toBe(16_000);
    expect(backoffCeilingMs(6, CFG)).toBe(30_000); // 32_000 capped to 30_000
    expect(backoffCeilingMs(7, CFG)).toBe(30_000); // stays capped
  });

  test('attempt < 1 is zero', () => {
    expect(backoffCeilingMs(0, CFG)).toBe(0);
    expect(backoffCeilingMs(-3, CFG)).toBe(0);
  });

  test('the default config caps at one hour', () => {
    expect(backoffCeilingMs(1, DEFAULT_BACKOFF)).toBe(1_000);
    expect(backoffCeilingMs(100, DEFAULT_BACKOFF)).toBe(DEFAULT_BACKOFF.maxMs);
  });
});

describe('nextRetryDelayMs — equal jitter in [ceiling/2, ceiling]', () => {
  test('rng=0 → exactly half the ceiling (never zero)', () => {
    expect(nextRetryDelayMs(3, CFG, () => 0)).toBe(2_000); // 4000/2
  });

  test('rng=0.5 → three-quarters of the ceiling', () => {
    expect(nextRetryDelayMs(3, CFG, () => 0.5)).toBe(3_000); // 2000 + 0.5*2000
  });

  test('rng near 1 → approaches the full ceiling', () => {
    expect(nextRetryDelayMs(3, CFG, () => 0.999999)).toBe(4_000);
  });

  test('every jittered value stays within the documented band', () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const ceil = backoffCeilingMs(attempt, CFG);
      for (const r of [0, 0.1, 0.37, 0.5, 0.83, 0.999999]) {
        const delay = nextRetryDelayMs(attempt, CFG, () => r);
        expect(delay).toBeGreaterThanOrEqual(ceil / 2);
        expect(delay).toBeLessThanOrEqual(ceil);
      }
    }
  });
});

describe('isDeadLettered', () => {
  test('true once attempts reaches maxAttempts', () => {
    expect(isDeadLettered(5, CFG)).toBe(false);
    expect(isDeadLettered(6, CFG)).toBe(true);
    expect(isDeadLettered(7, CFG)).toBe(true);
  });
});
