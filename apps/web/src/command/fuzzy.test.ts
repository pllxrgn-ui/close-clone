import { describe, expect, test } from 'vitest';
import { fuzzyMatch, scoreEntry } from './fuzzy.ts';

describe('fuzzyMatch', () => {
  test('matches a contiguous substring and reports its range', () => {
    const result = fuzzyMatch('lea', 'Leads');
    expect(result).not.toBeNull();
    expect(result?.ranges).toEqual([[0, 3]]);
  });

  test('matches a non-contiguous subsequence', () => {
    const result = fuzzyMatch('gl', 'Go to Leads');
    expect(result).not.toBeNull();
    // 'g' at 0, 'l' at 6
    expect(result?.ranges).toEqual([
      [0, 1],
      [6, 7],
    ]);
  });

  test('returns null when a query character is absent', () => {
    expect(fuzzyMatch('xyz', 'Leads')).toBeNull();
  });

  test('an empty query matches everything neutrally', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, ranges: [] });
  });

  test('is case-insensitive', () => {
    expect(fuzzyMatch('LEADS', 'leads')).not.toBeNull();
  });

  test('ranks a start-of-string match above a mid-word one', () => {
    const atStart = fuzzyMatch('set', 'Settings');
    const midWord = fuzzyMatch('set', 'Reset');
    expect(atStart).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect((atStart?.score ?? 0) > (midWord?.score ?? 0)).toBe(true);
  });

  test('ranks a shorter target above a longer one for the same hit', () => {
    const short = fuzzyMatch('rep', 'Reports');
    const long = fuzzyMatch('rep', 'Reports and analytics dashboard');
    expect((short?.score ?? 0) > (long?.score ?? 0)).toBe(true);
  });
});

describe('scoreEntry', () => {
  test('matches via a keyword alias while keeping title ranges empty', () => {
    // 'compose' is not in the title, but is a keyword.
    const result = scoreEntry('compose', 'New email', ['compose', 'draft']);
    expect(result).not.toBeNull();
    expect(result?.ranges).toEqual([]);
  });

  test('prefers a title match and returns its ranges', () => {
    const result = scoreEntry('new', 'New email', ['compose']);
    expect(result?.ranges).toEqual([[0, 3]]);
  });

  test('returns null when neither title nor keywords match', () => {
    expect(scoreEntry('zzz', 'New email', ['compose'])).toBeNull();
  });
});
