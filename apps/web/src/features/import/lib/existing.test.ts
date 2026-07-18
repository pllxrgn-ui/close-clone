import { describe, expect, test } from 'vitest';
import { buildExistingIndex } from './existing.ts';
import { normalizeName } from './normalize.ts';

const LEADS = [
  { id: 'L1', name: 'North Labs', url: 'https://north-labs.example.com' },
  { id: 'L2', name: 'Copper Freight', url: null },
];
const CONTACTS = [
  { leadId: 'L1', emails: ['sam@north-labs.example.com'] },
  { leadId: 'L2', emails: ['jo@copper-freight.example.com'] },
];

describe('buildExistingIndex', () => {
  const idx = buildExistingIndex(LEADS, CONTACTS, new Set(['blocked@north-labs.example.com']));

  test('matches by an existing contact email (case-insensitive)', () => {
    expect(idx.matchByEmail('SAM@north-labs.example.com')).toBe('L1');
    expect(idx.matchByEmail('nobody@x.com')).toBeNull();
  });

  test('matches by a lead url domain', () => {
    expect(idx.matchByDomain('north-labs.example.com')).toBe('L1');
  });

  test('matches by a contact email domain when the lead has no url', () => {
    expect(idx.matchByDomain('copper-freight.example.com')).toBe('L2');
  });

  test('fuzzy-matches an existing company name', () => {
    expect(idx.matchByName(normalizeName('North Labs'), 0.45)).toBe('L1');
    expect(idx.matchByName(normalizeName('Unrelated Group'), 0.45)).toBeNull();
  });

  test('reports suppressed addresses case-insensitively', () => {
    expect(idx.isSuppressed('Blocked@North-Labs.example.com')).toBe(true);
    expect(idx.isSuppressed('sam@north-labs.example.com')).toBe(false);
  });
});
