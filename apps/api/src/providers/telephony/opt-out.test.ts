import { describe, expect, test } from 'vitest';
import { OPT_OUT_KEYWORDS, matchOptOutKeyword } from './opt-out.ts';

/** §I-QUIET opt-out keyword classification (task 3a). */
describe('matchOptOutKeyword', () => {
  test('matches every contract keyword (§C6 I-QUIET)', () => {
    expect(OPT_OUT_KEYWORDS).toEqual(['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END']);
    for (const kw of OPT_OUT_KEYWORDS) {
      expect(matchOptOutKeyword(kw)).toBe(kw);
    }
  });

  test('is case-insensitive and trims surrounding whitespace', () => {
    expect(matchOptOutKeyword('stop')).toBe('STOP');
    expect(matchOptOutKeyword('  Stop  ')).toBe('STOP');
    expect(matchOptOutKeyword('\tUNSUBSCRIBE\n')).toBe('UNSUBSCRIBE');
  });

  test('does not match a keyword merely contained in a sentence', () => {
    expect(matchOptOutKeyword('please stop emailing me')).toBeNull();
    expect(matchOptOutKeyword('the end is near')).toBeNull();
  });

  test('returns null for a non-keyword body', () => {
    expect(matchOptOutKeyword('hello')).toBeNull();
    expect(matchOptOutKeyword('')).toBeNull();
  });
});
