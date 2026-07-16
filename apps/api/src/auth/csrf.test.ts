import { describe, expect, test } from 'vitest';

import { CSRF_HEADER, hasCsrfHeader, isMutatingMethod } from './csrf.ts';

/** Task 5a — CSRF custom-header check. */

describe('isMutatingMethod', () => {
  test('GET/HEAD/OPTIONS are safe', () => {
    expect(isMutatingMethod('GET')).toBe(false);
    expect(isMutatingMethod('head')).toBe(false);
    expect(isMutatingMethod('OPTIONS')).toBe(false);
  });
  test('POST/PUT/PATCH/DELETE are mutating', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isMutatingMethod(m)).toBe(true);
    }
  });
});

describe('hasCsrfHeader', () => {
  test('present non-empty header → true', () => {
    expect(hasCsrfHeader({ [CSRF_HEADER]: '1' })).toBe(true);
  });
  test('absent or empty → false', () => {
    expect(hasCsrfHeader({})).toBe(false);
    expect(hasCsrfHeader({ [CSRF_HEADER]: '' })).toBe(false);
  });
  test('array header with a non-empty value → true', () => {
    expect(hasCsrfHeader({ [CSRF_HEADER]: ['', 'x'] })).toBe(true);
  });
});
