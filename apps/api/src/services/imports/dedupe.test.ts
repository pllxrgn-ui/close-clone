import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { contacts, leads, suppressions, users, type Db } from '../../db/index.ts';
import {
  buildExistingIndex,
  deriveDomains,
  domainFromEmail,
  domainFromUrl,
  type ExistingIndex,
} from './dedupe.ts';

const USER = '00000000-0000-4000-8000-0000000000d1';
const L_ACME = '11111111-0000-4000-8000-0000000000d1';
const L_GLOBEX = '11111111-0000-4000-8000-0000000000d2';

let ctx: TestDb;
let index: ExistingIndex;

async function seed(db: Db): Promise<void> {
  await db.insert(users).values({
    id: USER,
    email: 'd@example.com',
    name: 'D',
    role: 'admin',
    idpSubject: 'idp|d',
  });
  await db.insert(leads).values([
    { id: L_ACME, name: 'Acme Corporation', url: 'https://www.acme.com/about' },
    { id: L_GLOBEX, name: 'Globex LLC', url: 'globex.io' },
  ]);
  await db.insert(contacts).values([
    {
      id: '22222222-0000-4000-8000-0000000000d1',
      leadId: L_ACME,
      name: 'Alice',
      emails: [{ email: 'alice@acme.com', type: 'work' }],
    },
    {
      id: '22222222-0000-4000-8000-0000000000d2',
      leadId: L_GLOBEX,
      name: 'Bob',
      emails: [{ email: 'bob@globex.io', type: 'work' }],
    },
  ]);
  await db.insert(suppressions).values({
    kind: 'email',
    value: 'blocked@acme.com',
    source: 'unsubscribe',
  });
  // A released suppression must NOT count as suppressed.
  await db.insert(suppressions).values({
    kind: 'email',
    value: 'released@acme.com',
    source: 'bounce',
    releasedAt: new Date().toISOString(),
  });
}

beforeAll(async () => {
  ctx = await createTestDb();
  await seed(ctx.db);
  index = await buildExistingIndex(ctx.db);
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

describe('domain extraction', () => {
  test('domainFromUrl normalises scheme, www, path', () => {
    expect(domainFromUrl('https://www.acme.com/about')).toBe('acme.com');
    expect(domainFromUrl('acme.com')).toBe('acme.com');
    expect(domainFromUrl('HTTP://Acme.COM')).toBe('acme.com');
    expect(domainFromUrl('not a url')).toBeNull();
    expect(domainFromUrl('')).toBeNull();
    expect(domainFromUrl('localhost')).toBeNull();
  });

  test('domainFromEmail excludes free providers', () => {
    expect(domainFromEmail('alice@acme.com')).toBe('acme.com');
    expect(domainFromEmail('joe@gmail.com')).toBeNull();
    expect(domainFromEmail('bad')).toBeNull();
  });

  test('deriveDomains prefers url domain, falls back to non-free email domain', () => {
    expect(deriveDomains('https://acme.com', 'x@gmail.com')).toEqual(['acme.com']);
    expect(deriveDomains(null, 'x@globex.io')).toEqual(['globex.io']);
    expect(deriveDomains(null, 'x@gmail.com')).toEqual([]);
  });
});

describe('buildExistingIndex — exact matches', () => {
  test('matches an existing lead by contact email (exact)', () => {
    expect(index.matchByEmail('alice@acme.com')).toBe(L_ACME);
    expect(index.matchByEmail('ALICE@acme.com')).toBe(L_ACME);
    expect(index.matchByEmail('nobody@acme.com')).toBeNull();
  });

  test('matches an existing lead by company domain (url + contact email domains)', () => {
    expect(index.matchByDomain('acme.com')).toBe(L_ACME);
    expect(index.matchByDomain('globex.io')).toBe(L_GLOBEX);
    expect(index.matchByDomain('unknown.com')).toBeNull();
  });

  test('flags active suppressions but not released ones', () => {
    expect(index.isSuppressed('blocked@acme.com')).toBe(true);
    expect(index.isSuppressed('BLOCKED@acme.com')).toBe(true);
    expect(index.isSuppressed('released@acme.com')).toBe(false);
    expect(index.isSuppressed('alice@acme.com')).toBe(false);
  });
});

describe('buildExistingIndex — fuzzy name (pg_trgm)', () => {
  test('matches a close company-name variant above threshold', async () => {
    expect(await index.matchByFuzzyName(ctx.db, 'Acme Corp', 0.4)).toBe(L_ACME);
    expect(await index.matchByFuzzyName(ctx.db, 'ACME CORPORATION', 0.4)).toBe(L_ACME);
  });

  test('does not match an unrelated name', async () => {
    expect(await index.matchByFuzzyName(ctx.db, 'Umbrella Industries', 0.4)).toBeNull();
  });

  test('threshold gates the match', async () => {
    // "Acme" alone is only a partial trigram overlap with "Acme Corporation".
    expect(await index.matchByFuzzyName(ctx.db, 'Acme', 0.9)).toBeNull();
  });
});
