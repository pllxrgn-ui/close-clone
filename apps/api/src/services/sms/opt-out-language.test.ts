import { describe, expect, test } from 'vitest';
import {
  DEFAULT_OPT_OUT_LANGUAGE,
  appendOptOutLanguage,
  bodyHasOptOutLanguage,
} from './opt-out-language.ts';

/** §4.5 first-contact opt-out language helpers. */

describe('bodyHasOptOutLanguage', () => {
  test('detects a standalone STOP-family keyword (case-insensitive)', () => {
    expect(bodyHasOptOutLanguage('Reply STOP to opt out')).toBe(true);
    expect(bodyHasOptOutLanguage('text quit anytime')).toBe(true);
    expect(bodyHasOptOutLanguage('Send CANCEL to end')).toBe(true);
  });

  test('does not false-positive on a substring', () => {
    expect(bodyHasOptOutLanguage('our nonstop deals')).toBe(false);
    expect(bodyHasOptOutLanguage('hello there')).toBe(false);
  });
});

describe('appendOptOutLanguage', () => {
  test('appends the default sentence with a single space', () => {
    expect(appendOptOutLanguage('Hello')).toBe(`Hello ${DEFAULT_OPT_OUT_LANGUAGE}`);
  });

  test('collapses trailing whitespace before the separator', () => {
    expect(appendOptOutLanguage('Hello   ')).toBe(`Hello ${DEFAULT_OPT_OUT_LANGUAGE}`);
  });

  test('honours a custom override sentence', () => {
    expect(appendOptOutLanguage('Hi', 'Txt STOP to quit.')).toBe('Hi Txt STOP to quit.');
  });

  test('an empty body yields just the suffix', () => {
    expect(appendOptOutLanguage('')).toBe(DEFAULT_OPT_OUT_LANGUAGE);
  });
});
