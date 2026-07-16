import { describe, expect, test } from 'vitest';
import {
  QUIET_HOURS_DEFAULT_END_MIN,
  QUIET_HOURS_DEFAULT_START_MIN,
  isWithinAllowedHours,
  parseQuietHours,
  resolveQuietHoursTimezone,
} from './quiet-hours.ts';

/** I-QUIET quiet-hours window parsing + the DST-correct in-window check. */

describe('parseQuietHours', () => {
  test('null / undefined / empty ⇒ the 8am–9pm default window', () => {
    for (const raw of [null, undefined, {}]) {
      const w = parseQuietHours(raw);
      expect(w.startMin).toBe(QUIET_HOURS_DEFAULT_START_MIN);
      expect(w.endMin).toBe(QUIET_HOURS_DEFAULT_END_MIN);
      expect(w.timezoneOverride).toBeNull();
    }
  });

  test('explicit start/end/timezone override the defaults', () => {
    const w = parseQuietHours({ start: '09:30', end: '18:00', timezone: 'America/Chicago' });
    expect(w.startMin).toBe(9 * 60 + 30);
    expect(w.endMin).toBe(18 * 60);
    expect(w.timezoneOverride).toBe('America/Chicago');
  });

  test('a single specified bound keeps the default for the other', () => {
    const w = parseQuietHours({ start: '10:00' });
    expect(w.startMin).toBe(10 * 60);
    expect(w.endMin).toBe(QUIET_HOURS_DEFAULT_END_MIN);
  });

  test('a malformed jsonb falls back to the safe default window', () => {
    const w = parseQuietHours({ start: '25:99', end: 'nope' });
    expect(w.startMin).toBe(QUIET_HOURS_DEFAULT_START_MIN);
    expect(w.endMin).toBe(QUIET_HOURS_DEFAULT_END_MIN);
  });
});

describe('resolveQuietHoursTimezone', () => {
  const dflt = parseQuietHours(null);

  test('jsonb override wins over recipient + company', () => {
    const w = parseQuietHours({ timezone: 'America/Denver' });
    expect(resolveQuietHoursTimezone(w, 'America/New_York', 'UTC')).toBe('America/Denver');
  });

  test('recipient tz used when no override', () => {
    expect(resolveQuietHoursTimezone(dflt, 'America/New_York', 'UTC')).toBe('America/New_York');
  });

  test('company tz used when no override and no recipient', () => {
    expect(resolveQuietHoursTimezone(dflt, null, 'America/Chicago')).toBe('America/Chicago');
  });

  test('UTC as the ultimate fallback', () => {
    expect(resolveQuietHoursTimezone(dflt, null, '')).toBe('UTC');
  });
});

describe('isWithinAllowedHours (DST-correct via Intl)', () => {
  const w = parseQuietHours(null); // 08:00–21:00

  test('noon Eastern is inside for a New_York recipient', () => {
    // 16:00 UTC in July (EDT = UTC-4) → 12:00 local.
    expect(isWithinAllowedHours(new Date('2026-07-15T16:00:00Z'), 'America/New_York', w)).toBe(
      true,
    );
  });

  test('the 8am open is inclusive; one minute before is outside', () => {
    // 12:00 UTC → 08:00 EDT (inside); 11:59 UTC → 07:59 EDT (outside).
    expect(isWithinAllowedHours(new Date('2026-07-15T12:00:00Z'), 'America/New_York', w)).toBe(
      true,
    );
    expect(isWithinAllowedHours(new Date('2026-07-15T11:59:00Z'), 'America/New_York', w)).toBe(
      false,
    );
  });

  test('the 9pm close is exclusive', () => {
    // 01:00 UTC (next day) → 21:00 EDT → outside; 00:59 UTC → 20:59 → inside.
    expect(isWithinAllowedHours(new Date('2026-07-16T01:00:00Z'), 'America/New_York', w)).toBe(
      false,
    );
    expect(isWithinAllowedHours(new Date('2026-07-16T00:59:00Z'), 'America/New_York', w)).toBe(
      true,
    );
  });

  test('midnight Eastern is outside', () => {
    expect(isWithinAllowedHours(new Date('2026-07-15T04:00:00Z'), 'America/New_York', w)).toBe(
      false,
    );
  });
});
