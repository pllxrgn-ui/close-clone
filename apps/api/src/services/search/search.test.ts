import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { InvalidCursorError, SearchService, type SearchPage } from './index.ts';

/**
 * Task 1e — SearchService.
 *
 * `createTestDb` applies migrations 0000 → 0003 (incl. `CREATE EXTENSION
 * pg_trgm` + the generated search columns / trigram indexes) from an empty
 * PGlite database, so the suite booting at all proves the chain applies clean.
 * The tests then exercise each search signal against a hand-seeded dataset: FTS
 * name match, trigram partial/typo, contact email, phone substring, ranking
 * (exact beats fuzzy), keyset pagination, soft-delete exclusion, and the
 * empty/short-query and bad-cursor failure paths.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const L_ACME = '11111111-0000-4000-8000-000000000001';
const L_ACME_CORP = '11111111-0000-4000-8000-000000000002';
const L_GLOBEX = '11111111-0000-4000-8000-000000000003';
const L_DELETED = '11111111-0000-4000-8000-0000000000de';
const C_ALICE = '22222222-0000-4000-8000-000000000001';
const C_BOB = '22222222-0000-4000-8000-000000000002';
const C_DELETED = '22222222-0000-4000-8000-0000000000de';

let ctx: TestDb;
let service: SearchService;

async function seed(): Promise<void> {
  await ctx.client.exec(`
    INSERT INTO users (id, email, name, role, idp_subject) VALUES
      ('${USER}', 'u@example.com', 'Rep One', 'rep', 'idp|u');
    INSERT INTO leads (id, name, url, description, owner_id) VALUES
      ('${L_ACME}', 'Acme', 'https://acme.example.com', 'widget maker', '${USER}'),
      ('${L_ACME_CORP}', 'Acme Corporation', 'https://acmecorp.io', 'big widgets', '${USER}'),
      ('${L_GLOBEX}', 'Globex Industries', 'https://globex.com', 'gadgets', '${USER}');
    INSERT INTO leads (id, name, url, owner_id, deleted_at) VALUES
      ('${L_DELETED}', 'Acme Deleted Ghost', 'https://ghost.example.com', '${USER}', now());
    INSERT INTO contacts (id, lead_id, name, title, emails, phones) VALUES
      ('${C_ALICE}', '${L_ACME}', 'Alice Johnson', 'VP Sales',
        '[{"email":"alice@acme.example.com","type":"work"}]',
        '[{"phone":"+15551234567","type":"mobile"}]'),
      ('${C_BOB}', '${L_GLOBEX}', 'Bob Smith', 'CTO',
        '[{"email":"bob@globex.com","type":"work"}]',
        '[{"phone":"5559876543","type":"work"}]');
    INSERT INTO contacts (id, lead_id, name, emails, deleted_at) VALUES
      ('${C_DELETED}', '${L_GLOBEX}', 'Alice Ghost',
        '[{"email":"alice@ghost.example.com","type":"work"}]', now());
  `);
}

beforeAll(async () => {
  ctx = await createTestDb();
  service = new SearchService(ctx.db);
  await seed();
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

describe('migration / extension', () => {
  test('migrations 0000→0003 applied and pg_trgm available', async () => {
    const migs = await ctx.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    // Bumped 4 → 5 by Task 5b's migration 0011 (audit_log append-only trigger),
    // → 7 by migration 0012 (per-lead + keyset perf indexes, D-037).
    expect(migs.rows[0]?.n).toBe(7);
    const ext = await ctx.client.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    expect(ext.rows).toHaveLength(1);
  });

  test('search generated columns and trigram/FTS indexes exist', async () => {
    const cols = await ctx.client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name IN ('search_tsv', 'search_text')
         AND table_name IN ('leads', 'contacts')
       ORDER BY table_name, column_name`,
    );
    // leads: search_tsv (pre-existing) + search_text (1e); contacts: both (1e).
    expect(cols.rows).toEqual([
      { table_name: 'contacts', column_name: 'search_text' },
      { table_name: 'contacts', column_name: 'search_tsv' },
      { table_name: 'leads', column_name: 'search_text' },
      { table_name: 'leads', column_name: 'search_tsv' },
    ]);

    const idx = await ctx.client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('leads_name_trgm_idx', 'leads_search_text_trgm_idx',
                           'contacts_name_trgm_idx', 'contacts_search_text_trgm_idx',
                           'contacts_search_tsv_gin_idx')`,
    );
    expect(idx.rows).toHaveLength(5);
    for (const row of idx.rows) {
      expect(row.indexdef).toContain('USING gin');
      if (row.indexname.endsWith('_trgm_idx')) {
        expect(row.indexdef).toContain('gin_trgm_ops');
      }
    }
  });
});

describe('FTS', () => {
  test('finds a lead by whole-word name', async () => {
    const page = await service.search('Globex');
    const lead = page.items.find((i) => i.type === 'lead');
    expect(lead?.id).toBe(L_GLOBEX);
    expect(lead?.leadId).toBe(L_GLOBEX);
    expect(lead?.title).toBe('Globex Industries');
  });

  test('finds a contact by name token', async () => {
    const page = await service.search('Johnson');
    expect(page.items.some((i) => i.type === 'contact' && i.id === C_ALICE)).toBe(true);
  });
});

describe('trigram', () => {
  test('partial/prefix match (company slug inside a URL)', async () => {
    // "acmecorp" is a substring of the acmecorp.io URL, not an FTS token.
    const page = await service.search('acmecorp');
    expect(page.items.some((i) => i.id === L_ACME_CORP)).toBe(true);
  });

  test('typo-tolerant name match', async () => {
    const page = await service.search('Jonson'); // Johnson, transposed
    expect(page.items.some((i) => i.id === C_ALICE)).toBe(true);
  });

  test('partial prefix of a lead name', async () => {
    const page = await service.search('Globe');
    expect(page.items.some((i) => i.id === L_GLOBEX)).toBe(true);
  });
});

describe('contact email / phone', () => {
  test('finds a contact by full email address', async () => {
    const page = await service.search('alice@acme.example.com');
    const hit = page.items.find((i) => i.id === C_ALICE);
    expect(hit).toBeDefined();
    expect(hit?.subtitle).toBe('alice@acme.example.com');
  });

  test('finds a contact by email domain fragment', async () => {
    const page = await service.search('globex.com');
    expect(page.items.some((i) => i.id === C_BOB)).toBe(true);
  });

  test('finds a contact by phone substring', async () => {
    const page = await service.search('987654');
    expect(page.items.some((i) => i.id === C_BOB)).toBe(true);
  });
});

describe('ranking', () => {
  test('exact name beats fuzzy', async () => {
    const page = await service.search('Acme');
    const acmeIdx = page.items.findIndex((i) => i.id === L_ACME);
    const corpIdx = page.items.findIndex((i) => i.id === L_ACME_CORP);
    expect(acmeIdx).toBeGreaterThanOrEqual(0);
    expect(corpIdx).toBeGreaterThanOrEqual(0);
    expect(acmeIdx).toBeLessThan(corpIdx);
    const acme = page.items[acmeIdx];
    const corp = page.items[corpIdx];
    expect(acme && corp && acme.rank > corp.rank).toBe(true);
  });

  test('deterministic ordering across identical calls', async () => {
    const a = await service.search('Acme');
    const b = await service.search('Acme');
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
  });
});

describe('soft-delete exclusion', () => {
  test('does not return soft-deleted leads or contacts', async () => {
    const page = await service.search('Acme', { limit: 100 });
    const ids = page.items.map((i) => i.id);
    expect(ids).not.toContain(L_DELETED);
    expect(ids).not.toContain(C_DELETED);
  });
});

describe('pagination (keyset)', () => {
  test('walks all Acme matches without overlap or gaps', async () => {
    const full = await service.search('Acme', { limit: 100 });
    const expectedIds = full.items.map((i) => i.id);
    expect(expectedIds.length).toBeGreaterThan(1);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page: SearchPage = await service.search('Acme', {
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(1);
      for (const i of page.items) seen.push(i.id);
      cursor = page.nextCursor;
      guard += 1;
      expect(guard).toBeLessThan(50);
    } while (cursor !== undefined);

    expect(seen).toEqual(expectedIds);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('last page omits nextCursor', async () => {
    const full = await service.search('Acme', { limit: 100 });
    expect(full.nextCursor).toBeUndefined();
  });
});

describe('failure / edge paths', () => {
  test('empty query yields an empty page (no error)', async () => {
    await expect(service.search('')).resolves.toEqual({ items: [] });
  });

  test('single-char query yields an empty page', async () => {
    await expect(service.search('a')).resolves.toEqual({ items: [] });
  });

  test('whitespace-only query yields an empty page', async () => {
    await expect(service.search('   ')).resolves.toEqual({ items: [] });
  });

  test('malformed cursor throws InvalidCursorError', async () => {
    await expect(service.search('Acme', { cursor: 'not-a-valid-cursor!!' })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });

  test('cursor with non-uuid id throws InvalidCursorError', async () => {
    const bad = Buffer.from('123:not-a-uuid', 'utf8').toString('base64url');
    await expect(service.search('Acme', { cursor: bad })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });

  test('limit is clamped (0 → at least one row)', async () => {
    const page = await service.search('Acme', { limit: 0 });
    expect(page.items.length).toBe(1);
  });

  test('no matches yields an empty page with no cursor', async () => {
    const page = await service.search('zzzznotathing');
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});
