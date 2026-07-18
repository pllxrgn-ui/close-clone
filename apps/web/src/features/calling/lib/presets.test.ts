import { describe, expect, test } from 'vitest';
import {
  CALL_OUTCOMES,
  VOICEMAIL_ASSETS,
  dispositionForOutcome,
  formatPhone,
  phoneMatchKey,
} from './presets.ts';

describe('call outcome presets', () => {
  test('outcome ids and labels are unique', () => {
    expect(new Set(CALL_OUTCOMES.map((o) => o.id)).size).toBe(CALL_OUTCOMES.length);
    expect(new Set(CALL_OUTCOMES.map((o) => o.label)).size).toBe(CALL_OUTCOMES.length);
  });

  test('dispositionForOutcome resolves a known label case-insensitively', () => {
    expect(dispositionForOutcome('Left voicemail')).toBe('voicemail');
    expect(dispositionForOutcome('  no answer ')).toBe('missed');
    expect(dispositionForOutcome('Connected')).toBe('completed');
  });

  test('dispositionForOutcome defaults an unknown/free-text label to completed', () => {
    expect(dispositionForOutcome('Had a great chat about pricing')).toBe('completed');
    expect(dispositionForOutcome('')).toBe('completed');
  });
});

describe('voicemail assets', () => {
  test('recordingRefs are unique, non-empty handles', () => {
    expect(new Set(VOICEMAIL_ASSETS.map((a) => a.recordingRef)).size).toBe(VOICEMAIL_ASSETS.length);
    for (const asset of VOICEMAIL_ASSETS) {
      expect(asset.recordingRef.length).toBeGreaterThan(0);
      expect(asset.durationS).toBeGreaterThan(0);
    }
  });
});

describe('phoneMatchKey', () => {
  test('normalizes to the last 10 significant digits (country-code agnostic)', () => {
    expect(phoneMatchKey('+1 (206) 555-0134')).toBe('2065550134');
    expect(phoneMatchKey('12065550134')).toBe('2065550134');
    expect(phoneMatchKey('2065550134')).toBe('2065550134');
  });

  test('two formattings of the same number share a key (rail agreement)', () => {
    expect(phoneMatchKey('+12065550134')).toBe(phoneMatchKey('(206) 555-0134'));
  });
});

describe('formatPhone', () => {
  test('groups a 10/11-digit number US-style', () => {
    expect(formatPhone('+12065550134')).toBe('(206) 555-0134');
    expect(formatPhone('2065550134')).toBe('(206) 555-0134');
  });

  test('passes through an unrecognized shape untouched', () => {
    expect(formatPhone('12')).toBe('12');
  });
});
