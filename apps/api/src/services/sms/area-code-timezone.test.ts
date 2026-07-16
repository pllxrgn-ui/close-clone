import { describe, expect, test } from 'vitest';
import { inferTimezoneFromNumber } from './area-code-timezone.ts';

/** NANP area-code → IANA timezone inference for the I-QUIET recipient-local check. */

describe('inferTimezoneFromNumber', () => {
  test('maps representative NPAs across every continental zone', () => {
    expect(inferTimezoneFromNumber('+13055550147')).toBe('America/New_York'); // 305 Miami
    expect(inferTimezoneFromNumber('+13125550100')).toBe('America/Chicago'); // 312 Chicago
    expect(inferTimezoneFromNumber('+13035550100')).toBe('America/Denver'); // 303 Denver
    expect(inferTimezoneFromNumber('+14155550188')).toBe('America/Los_Angeles'); // 415 SF
    expect(inferTimezoneFromNumber('+16025550100')).toBe('America/Phoenix'); // 602 Phoenix
    expect(inferTimezoneFromNumber('+19075550100')).toBe('America/Anchorage'); // 907 Alaska
    expect(inferTimezoneFromNumber('+18085550100')).toBe('Pacific/Honolulu'); // 808 Hawaii
  });

  test('is formatting-insensitive (uses the trailing-10-digit key)', () => {
    expect(inferTimezoneFromNumber('+1 (305) 555-0147')).toBe('America/New_York');
    expect(inferTimezoneFromNumber('3055550147')).toBe('America/New_York');
  });

  test('returns null for an unmapped NPA', () => {
    expect(inferTimezoneFromNumber('+19995550100')).toBeNull();
  });

  test('returns null for a too-short / non-NANP number', () => {
    expect(inferTimezoneFromNumber('12345')).toBeNull();
    expect(inferTimezoneFromNumber('')).toBeNull();
  });
});
