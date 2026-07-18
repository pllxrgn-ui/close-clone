import { describe, expect, test } from 'vitest';
import { deriveDomains, emailDomain, hostFromUrl, normalizeName } from './normalize.ts';

describe('hostFromUrl', () => {
  test('drops scheme, path, and a leading www', () => {
    expect(hostFromUrl('https://www.North-Labs.example.com/pricing?x=1')).toBe(
      'north-labs.example.com',
    );
  });
  test('accepts a bare host', () => {
    expect(hostFromUrl('marlowe-textiles.example.com')).toBe('marlowe-textiles.example.com');
  });
  test('is empty for empty/garbage input', () => {
    expect(hostFromUrl('')).toBe('');
    expect(hostFromUrl(null)).toBe('');
  });
});

describe('emailDomain', () => {
  test('lowercases the part after the @', () => {
    expect(emailDomain('Dana@Marlowe-Textiles.Example.com')).toBe('marlowe-textiles.example.com');
  });
  test('is empty when there is no @', () => {
    expect(emailDomain('not-an-email')).toBe('');
    expect(emailDomain(null)).toBe('');
  });
});

describe('deriveDomains', () => {
  test('collapses a url + email at the same domain to one entry', () => {
    expect(deriveDomains('https://acme.com', 'x@acme.com')).toEqual(['acme.com']);
  });
  test('keeps distinct url and email domains', () => {
    expect(deriveDomains('https://a.com', 'x@b.com')).toEqual(['a.com', 'b.com']);
  });
  test('drops empties', () => {
    expect(deriveDomains(null, 'x@b.com')).toEqual(['b.com']);
    expect(deriveDomains(null, null)).toEqual([]);
  });
});

describe('normalizeName', () => {
  test('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeName('  Acme,  Inc.  ')).toBe('acme inc');
    expect(normalizeName('North  Labs')).toBe('north labs');
  });
  test('is empty for null', () => {
    expect(normalizeName(null)).toBe('');
  });
});
