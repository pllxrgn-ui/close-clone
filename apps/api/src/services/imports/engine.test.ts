import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { customFieldDefs, users, type Db } from '../../db/index.ts';
import { commitImport } from './commit.ts';
import { createImport, dryRunImport, MappingValidationError } from './engine.ts';
import { ImportStorage } from './storage.ts';
import { EXPECTED_10K } from '../../../../../fixtures/imports/generate.ts';
import { dedupeConfigSchema, type ImportMapping } from './types.ts';

/**
 * Import engine end-to-end (Task 4f) on PGlite: upload → dry-run (no writes) →
 * commit; the messy fixture's exact error report; and the 10k-row scale/latency
 * + count test.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures/imports');
const USER = '00000000-0000-4000-8000-0000000000e1';

let ctx: TestDb;
let storage: ImportStorage;
let storeDir: string;

async function seed(db: Db): Promise<void> {
  await db.insert(users).values({
    id: USER,
    email: 'importer@example.com',
    name: 'Importer',
    role: 'admin',
    idpSubject: 'idp|engine',
  });
  await db.insert(customFieldDefs).values([
    { entity: 'lead', key: 'industry', label: 'Industry', type: 'text' },
    { entity: 'lead', key: 'employees', label: 'Employees', type: 'number' },
    { entity: 'lead', key: 'signed', label: 'Signed', type: 'date' },
  ]);
}

async function* strChunks(s: string): AsyncGenerator<Buffer> {
  yield Buffer.from(s, 'utf8');
}

const dedupe = dedupeConfigSchema.parse({});

async function count(db: Db, table: string, where = 'true'): Promise<number> {
  const r = await db.execute(sql.raw(`select count(*)::int as n from ${table} where ${where}`));
  return (r as { rows: { n: number }[] }).rows[0]?.n ?? -1;
}

beforeEach(async () => {
  ctx = await createTestDb();
  await seed(ctx.db);
  storeDir = await mkdtemp(join(tmpdir(), 'sb-import-engine-'));
  storage = new ImportStorage(storeDir);
}, 60_000);

afterEach(async () => {
  await ctx.close();
  await rm(storeDir, { recursive: true, force: true });
});

describe('engine — upload → dry-run → commit', () => {
  const mapping: ImportMapping = {
    columns: [
      { source: 'Company', target: 'lead.name' },
      { source: 'Website', target: 'lead.url' },
      { source: 'Email', target: 'contact.email' },
    ],
  };

  test('the full flow creates the right rows and events', async () => {
    const csv = 'Company,Website,Email\nAcme,https://acme.com,a@acme.com\nGlobex,globex.io,b@globex.io\n';
    const imp = await createImport(ctx.db, storage, {
      createdBy: USER,
      filename: 'leads.csv',
      source: strChunks(csv),
    });
    expect(imp.status).toBe('uploaded');

    const plan = await dryRunImport(ctx.db, storage, imp.id, { mapping, dedupe });
    expect(plan.counts.leadsCreated).toBe(2);
    expect(plan.counts.contactsCreated).toBe(2);
    // Dry-run writes NOTHING to leads/contacts.
    expect(await count(ctx.db, 'leads')).toBe(0);
    expect(await count(ctx.db, 'contacts')).toBe(0);

    const outcome = await commitImport(ctx.db, imp.id);
    expect(outcome.status).toBe('committed');
    expect(await count(ctx.db, 'leads')).toBe(2);
    expect(await count(ctx.db, 'contacts')).toBe(2);
    expect(await count(ctx.db, 'activities', "type = 'lead_created'")).toBe(2);
    expect(await count(ctx.db, 'activities', "type = 'import_created'")).toBe(2);
  });

  test('an unknown custom field in the mapping fails with MappingValidationError', async () => {
    const imp = await createImport(ctx.db, storage, {
      createdBy: USER,
      filename: 'x.csv',
      source: strChunks('Company\nAcme\n'),
    });
    await expect(
      dryRunImport(ctx.db, storage, imp.id, {
        mapping: { columns: [{ source: 'Company', target: 'custom.nonexistent' }] },
        dedupe,
      }),
    ).rejects.toBeInstanceOf(MappingValidationError);
  });
});

describe('engine — messy fixture (exact error report)', () => {
  const mapping: ImportMapping = {
    columns: [
      { source: 'Company', target: 'lead.name' },
      { source: 'Website', target: 'lead.url' },
      { source: 'Email', target: 'contact.email' },
      { source: 'Employees', target: 'custom.employees' },
      { source: 'Signed', target: 'custom.signed' },
      { source: 'Notes', target: 'lead.description' },
    ],
  };

  test('BOM/CRLF/quoting parse; bad cells + blank row reported exactly', async () => {
    const imp = await createImport(ctx.db, storage, {
      createdBy: USER,
      filename: 'messy.csv',
      source: createReadStream(join(FIXTURES, 'messy.csv')),
    });
    const plan = await dryRunImport(ctx.db, storage, imp.id, { mapping, dedupe });

    expect(plan.counts).toMatchObject({
      totalRows: 4,
      leadsCreated: 1,
      contactsCreated: 1,
      errorRows: 2,
      emptyRows: 1,
    });
    // Duplicate "Company" header is warned, not fatal.
    expect(plan.warnings.some((w) => w.includes('duplicate header "Company"'))).toBe(true);

    const byIndex = new Map(plan.rows.map((r) => [r.rowIndex, r]));
    // Row 1 (Acme): clean create; quoted comma in Notes parsed intact.
    const acme = byIndex.get(1);
    expect(acme?.outcome).toBe('create');
    expect(acme?.lead?.name).toBe('Acme');
    expect(acme?.lead?.description).toBe('Hello, world');
    expect(acme?.lead?.custom).toEqual({ employees: 250, signed: '2025-01-31' });
    // Row 2 (Globex): quoted comma name parsed; bad number + bad date reported.
    const globex = byIndex.get(2);
    expect(globex?.outcome).toBe('error');
    expect(globex?.errors.map((e) => e.code).sort()).toEqual(['invalid_date', 'invalid_number']);
    // Row 3: fully blank → empty.
    expect(byIndex.get(3)?.outcome).toBe('empty');
    // Row 4 (Initech): invalid email.
    const initech = byIndex.get(4);
    expect(initech?.outcome).toBe('error');
    expect(initech?.errors.map((e) => e.code)).toEqual(['invalid_email']);

    // Committing imports only the clean row.
    await commitImport(ctx.db, imp.id);
    expect(await count(ctx.db, 'leads')).toBe(1);
  });
});

describe('engine — 10k-row scale + latency', () => {
  const mapping: ImportMapping = {
    columns: [
      { source: 'Company', target: 'lead.name' },
      { source: 'Website', target: 'lead.url' },
      { source: 'Email', target: 'contact.email' },
      { source: 'Contact', target: 'contact.name' },
      { source: 'Title', target: 'contact.title' },
      { source: 'Industry', target: 'custom.industry' },
      { source: 'Employees', target: 'custom.employees' },
    ],
  };

  test(
    'imports 10k rows under 60s with exact counts',
    async () => {
      const imp = await createImport(ctx.db, storage, {
        createdBy: USER,
        filename: 'leads-10k.csv',
        source: createReadStream(join(FIXTURES, 'leads-10k.csv')),
      });

      const t0 = performance.now();
      const plan = await dryRunImport(ctx.db, storage, imp.id, { mapping, dedupe });
      const tDry = performance.now();
      expect(plan.counts).toMatchObject({
        totalRows: EXPECTED_10K.totalRows,
        errorRows: EXPECTED_10K.errorRows,
        dedupeSkipped: EXPECTED_10K.dedupeSkipped,
        leadsCreated: EXPECTED_10K.leadsCreated,
        contactsCreated: EXPECTED_10K.contactsCreated,
      });

      const outcome = await commitImport(ctx.db, imp.id, { batchSize: 1000 });
      const tCommit = performance.now();
      expect(outcome.status).toBe('committed');
      expect(outcome.counters.leads).toBe(EXPECTED_10K.leadsCreated);

      expect(await count(ctx.db, 'leads')).toBe(EXPECTED_10K.leadsCreated);
      expect(await count(ctx.db, 'contacts')).toBe(EXPECTED_10K.contactsCreated);
      expect(await count(ctx.db, 'activities')).toBe(EXPECTED_10K.leadsCreated * 2);

      const total = tCommit - t0;
      // eslint-disable-next-line no-console
      console.log(
        `[10k] dry-run ${Math.round(tDry - t0)}ms · commit ${Math.round(tCommit - tDry)}ms · total ${Math.round(total)}ms`,
      );
      expect(total).toBeLessThan(60_000);
    },
    120_000,
  );
});
