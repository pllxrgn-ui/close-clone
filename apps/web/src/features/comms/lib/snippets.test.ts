import { describe, expect, test } from 'vitest';
import type { Snippet } from '@switchboard/shared';
import { applySnippet, detectSlashToken, matchSnippets } from './snippets.ts';

function snip(shortcut: string, body: string): Snippet {
  return {
    id: `s-${shortcut}`,
    shortcut,
    body,
    ownerId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('detectSlashToken', () => {
  test('detects a token at the start of the text', () => {
    expect(detectSlashToken('/av', 3)).toEqual({ query: 'av', start: 0, end: 3 });
  });

  test('detects a token after whitespace', () => {
    expect(detectSlashToken('hello /cal', 10)).toEqual({ query: 'cal', start: 6, end: 10 });
  });

  test('a bare slash yields an empty query (menu shows everything)', () => {
    expect(detectSlashToken('hi /', 4)).toEqual({ query: '', start: 3, end: 4 });
  });

  test('does not fire when a space closed the token', () => {
    expect(detectSlashToken('hello /av then', 14)).toBeNull();
  });

  test('does not fire inside a URL (slash not preceded by whitespace)', () => {
    expect(detectSlashToken('see http://site', 15)).toBeNull();
  });

  test('does not fire on a mid-word slash', () => {
    expect(detectSlashToken('a/b', 3)).toBeNull();
  });

  test('reads the token only up to the caret, not past it', () => {
    // caret sits right after "/ca" inside "/calendly"
    expect(detectSlashToken('/calendly', 3)).toEqual({ query: 'ca', start: 0, end: 3 });
  });

  test('returns null when there is no slash', () => {
    expect(detectSlashToken('plain text', 5)).toBeNull();
  });
});

describe('matchSnippets', () => {
  const lib = [snip('avail', 'A'), snip('calendly', 'C'), snip('sig', 'S'), snip('apology', 'Ap')];

  test('prefix-matches case-insensitively and sorts by shortcut', () => {
    expect(matchSnippets('a', lib).map((s) => s.shortcut)).toEqual(['apology', 'avail']);
  });

  test('an empty query returns the whole library (sorted)', () => {
    expect(matchSnippets('', lib).map((s) => s.shortcut)).toEqual([
      'apology',
      'avail',
      'calendly',
      'sig',
    ]);
  });

  test('a non-matching query returns nothing', () => {
    expect(matchSnippets('zzz', lib)).toEqual([]);
  });
});

describe('applySnippet', () => {
  test('replaces the token with the body + trailing space and moves the caret', () => {
    const token = { query: 'av', start: 6, end: 9 };
    const result = applySnippet('hello /av', token, 'I am available Thursday');
    expect(result.text).toBe('hello I am available Thursday ');
    expect(result.caret).toBe('hello I am available Thursday '.length);
  });

  test('keeps text that follows the token intact', () => {
    const token = { query: 'sig', start: 4, end: 8 };
    const result = applySnippet('end /sig!!', token, 'Best,\nBen');
    expect(result.text).toBe('end Best,\nBen !!');
    expect(result.caret).toBe('end Best,\nBen '.length);
  });
});
