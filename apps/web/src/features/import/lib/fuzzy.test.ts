import { describe, expect, test } from 'vitest';
import { bestFuzzyMatch, trigramSimilarity } from './fuzzy.ts';

describe('trigramSimilarity', () => {
  test('is 1 for identical strings', () => {
    expect(trigramSimilarity('acme robotics', 'acme robotics')).toBe(1);
  });
  test('is 0 when either side is empty', () => {
    expect(trigramSimilarity('acme', '')).toBe(0);
    expect(trigramSimilarity('', '')).toBe(0);
  });
  test('rates a near-miss higher than an unrelated string', () => {
    const near = trigramSimilarity('acme robotics', 'acme robotic');
    const far = trigramSimilarity('acme robotics', 'zephyr freight');
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(0.5);
    expect(far).toBeLessThan(0.2);
  });
});

describe('bestFuzzyMatch', () => {
  const corpus = [
    { key: 'marlowe textiles', id: 'L1' },
    { key: 'kestrel provisions', id: 'L2' },
  ];
  test('returns the id of an exact-normalized match', () => {
    expect(bestFuzzyMatch('marlowe textiles', corpus, 0.45)).toBe('L1');
  });
  test('returns null when nothing clears the threshold', () => {
    expect(bestFuzzyMatch('totally unrelated group', corpus, 0.45)).toBeNull();
  });
  test('picks the strongest candidate when several are similar', () => {
    const c = [
      { key: 'acme robotics', id: 'A' },
      { key: 'acme robotic systems', id: 'B' },
    ];
    expect(bestFuzzyMatch('acme robotics', c, 0.3)).toBe('A');
  });
});
