import { describe, expect, test } from 'vitest';
import { initials } from './format.ts';

describe('initials', () => {
  test('takes first + last initial for a full name', () => {
    expect(initials('Ada Okafor')).toBe('AO');
    expect(initials('diego santos')).toBe('DS');
  });

  test('single name yields one letter', () => {
    expect(initials('Prince')).toBe('P');
  });

  test('collapses extra whitespace and uses the outer names', () => {
    expect(initials('  Mary  Jane  Watson ')).toBe('MW');
  });

  // failure path: empty / whitespace-only input has a stable fallback
  test('empty input falls back to a placeholder', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});
