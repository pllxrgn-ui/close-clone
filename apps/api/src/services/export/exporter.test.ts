import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  apiTokens,
  auditLog,
  contacts,
  customFieldDefs,
  emailAccounts,
  leads,
  leadStatuses,
  suppressions,
  users,
} from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { AuditWriter } from '../audit/index.ts';
import { loadGoldenFixtures } from '../fixtures/loader.ts';
import { runExport, type ExportManifest, type EntityExportResult } from './exporter.ts';

/**
 * Task 5g — the streaming full export. Covers: secrets excluded (oauth tokens,
 * api-token hash), suppressions + audit_log included, custom-field flattening
 * with non-catalog keys preserved, both output formats, audit bracketing, keyset
 * streaming across many pages, the empty-table edge, the 5k round-trip
 * (counts + spot-row), and a bad-destination failure path.
 */

const OWNER = '00000000-0000-4000-8000-00000000e001';
const SECRET_TOKEN = 'ya29.SUPER_SECRET_OAUTH_MATERIAL';
const SECRET_HASH = 'sha256:deadbeefcafef00dSECRETHASH';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');

async function countLines(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) if (line.length > 0) n += 1;
  } finally {
    rl.close();
  }
  return n;
}

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function firstLine(path: string): Promise<string> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length > 0) return line;
    }
  } finally {
    rl.close();
  }
  return '';
}

function byName(manifest: ExportManifest, name: string): EntityExportResult {
  const found = manifest.entities.find((e) => e.name === name);
  if (!found) throw new Error(`entity ${name} missing from manifest`);
  return found;
}

describe('runExport — seeded small dataset', () => {
  let ctx: TestDb;
  let dir: string;
  let manifest: ExportManifest;

  beforeAll(async () => {
    ctx = await createTestDb();
    dir = await mkdtemp(join(tmpdir(), 'sb-export-'));

    await ctx.db.insert(users).values({
      id: OWNER,
      email: 'owner@x.test',
      name: 'Owner',
      role: 'admin',
      idpSubject: 'idp|owner',
    });
    const [status] = await ctx.db
      .insert(leadStatuses)
      .values({ label: 'Potential', sortOrder: 0 })
      .returning({ id: leadStatuses.id });

    // Custom-field catalog for leads (three of the fixture keys); `is_target`
    // is deliberately NOT catalogued so we can prove non-catalog keys survive.
    await ctx.db.insert(customFieldDefs).values([
      { entity: 'lead', key: 'industry', label: 'Industry', type: 'select' },
      { entity: 'lead', key: 'employees', label: 'Employees', type: 'number' },
      { entity: 'lead', key: 'renewal_date', label: 'Renewal', type: 'date' },
    ]);

    const [lead] = await ctx.db
      .insert(leads)
      .values({
        name: 'Acme, Ltd',
        url: 'https://acme.example.com',
        description: 'line1\nline2 "quoted"',
        statusId: status?.id ?? null,
        ownerId: OWNER,
        custom: { industry: 'media', employees: 4087, is_target: true },
        dnc: false,
      })
      .returning({ id: leads.id });
    await ctx.db.insert(contacts).values({
      leadId: lead?.id ?? '',
      name: 'Jane Doe',
      emails: [{ email: 'jane@acme.test', type: 'work' }],
      phones: [],
    });

    // Secret-bearing rows.
    await ctx.db.insert(emailAccounts).values({
      userId: OWNER,
      address: 'inbox@acme.test',
      provider: 'mock',
      oauthTokens: SECRET_TOKEN,
      syncStatus: 'LIVE',
    });
    await ctx.db.insert(apiTokens).values({
      name: 'ci-token',
      hash: SECRET_HASH,
      scopes: ['read'],
      createdBy: OWNER,
    });
    // Compliance record — must be INCLUDED.
    await ctx.db.insert(suppressions).values({
      kind: 'email',
      value: 'blocked@acme.test',
      source: 'unsubscribe',
    });

    manifest = await runExport(ctx.db, {
      outDir: dir,
      format: 'both',
      audit: { writer: new AuditWriter(ctx.db), actorType: 'system' },
    });
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('writes one jsonl + one csv file per entity', () => {
    const leadsRes = byName(manifest, 'leads');
    expect(leadsRes.files.some((f) => f.endsWith('leads.jsonl'))).toBe(true);
    expect(leadsRes.files.some((f) => f.endsWith('leads.csv'))).toBe(true);
    expect(existsSync(join(dir, 'leads.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'contacts.csv'))).toBe(true);
    expect(existsSync(join(dir, 'audit_log.jsonl'))).toBe(true);
  });

  test('oauth_tokens is excluded and its value never appears on disk', () => {
    const rows = readJsonl(join(dir, 'email_accounts.jsonl'));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).not.toContain('oauth_tokens');
    expect(rows[0]?.['address']).toBe('inbox@acme.test');
    const raw = readFileSync(join(dir, 'email_accounts.jsonl'), 'utf8');
    const rawCsv = readFileSync(join(dir, 'email_accounts.csv'), 'utf8');
    expect(raw).not.toContain(SECRET_TOKEN);
    expect(rawCsv).not.toContain(SECRET_TOKEN);
    expect(rawCsv.split('\n')[0]).not.toContain('oauth_tokens');
  });

  test('api-token hash is excluded and its value never appears on disk', () => {
    const rows = readJsonl(join(dir, 'api_tokens.jsonl'));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).not.toContain('hash');
    expect(readFileSync(join(dir, 'api_tokens.jsonl'), 'utf8')).not.toContain(SECRET_HASH);
  });

  test('suppressions and audit_log are included (data ownership)', () => {
    const supp = readJsonl(join(dir, 'suppressions.jsonl'));
    expect(supp).toHaveLength(1);
    expect(supp[0]?.['value']).toBe('blocked@acme.test');

    // audit_log.jsonl was written after export.started, so it contains it.
    const audit = readJsonl(join(dir, 'audit_log.jsonl'));
    expect(audit.some((r) => r['action'] === 'export.started')).toBe(true);
  });

  test('custom fields flatten per catalog, raw custom keeps non-catalog keys', () => {
    const rows = readJsonl(join(dir, 'leads.jsonl'));
    expect(rows).toHaveLength(1);
    const lead = rows[0] ?? {};
    // Flattened catalog columns.
    expect(lead['custom.industry']).toBe('media');
    expect(lead['custom.employees']).toBe(4087);
    expect(lead['custom.renewal_date']).toBeNull(); // catalogued but unset on this lead
    // Raw custom object still present → non-catalog key survives.
    expect(lead['custom']).toMatchObject({ is_target: true });
    // Generated columns are NOT exported.
    expect(Object.keys(lead)).not.toContain('search_tsv');
    expect(Object.keys(lead)).not.toContain('search_text');
  });

  test('csv header is deterministic: id first, flattened columns present', () => {
    const header = readFileSync(join(dir, 'leads.csv'), 'utf8').split('\n')[0] ?? '';
    const cols = header.split(',');
    expect(cols[0]).toBe('id');
    expect(cols).toContain('custom');
    expect(cols).toContain('custom.industry');
    expect(cols).toContain('custom.employees');
    expect(cols).not.toContain('search_tsv');
  });

  test('emits export.started and export.completed audit events', async () => {
    const started = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'export.started'));
    const completed = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'export.completed'));
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0]?.entityId).toBe(manifest.exportId);
    expect(completed[0]?.entityId).toBe(manifest.exportId);
  });

  test('manifest row counts match the DB', () => {
    expect(byName(manifest, 'leads').rows).toBe(1);
    expect(byName(manifest, 'contacts').rows).toBe(1);
    expect(byName(manifest, 'users').rows).toBe(1);
    expect(byName(manifest, 'email_accounts').rows).toBe(1);
    expect(byName(manifest, 'api_tokens').rows).toBe(1);
    expect(byName(manifest, 'suppressions').rows).toBe(1);
  });
});

describe('runExport — edges and failure paths', () => {
  let ctx: TestDb;
  let dir: string;

  beforeAll(async () => {
    ctx = await createTestDb();
    dir = await mkdtemp(join(tmpdir(), 'sb-export-edge-'));
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('an empty table yields an empty jsonl and a header-only csv (no crash)', async () => {
    const out = join(dir, 'empty');
    const manifest = await runExport(ctx.db, { outDir: out, format: 'both' });
    expect(byName(manifest, 'notes').rows).toBe(0);
    expect(await countLines(join(out, 'notes.jsonl'))).toBe(0);
    // csv still has exactly its header line.
    const csv = readFileSync(join(out, 'notes.csv'), 'utf8').split('\n').filter((l) => l.length > 0);
    expect(csv).toHaveLength(1);
    expect(csv[0]?.startsWith('id,')).toBe(true);
  });

  test('without an audit context, no audit rows are written', async () => {
    const out = join(dir, 'noaudit');
    await runExport(ctx.db, { outDir: out, format: 'jsonl' });
    const rows = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    expect(rows[0]?.n).toBe(0);
  });

  test('keyset streaming returns every row across many small pages', async () => {
    const out = join(dir, 'paged');
    // Seed a handful of users; export with batchSize 2 → forces multiple pages.
    for (let i = 0; i < 5; i += 1) {
      await ctx.db.insert(users).values({
        email: `p${i}@x.test`,
        name: `P${i}`,
        role: 'rep',
        idpSubject: `idp|p${i}`,
      });
    }
    const manifest = await runExport(ctx.db, {
      outDir: out,
      format: 'jsonl',
      batchSize: 2,
      entities: [{ table: users }],
    });
    expect(byName(manifest, 'users').rows).toBe(5);
    expect(await countLines(join(out, 'users.jsonl'))).toBe(5);
  });

  test('a bad destination (parent is a file) rejects', async () => {
    const filePath = join(dir, 'iamafile');
    writeFileSync(filePath, 'not a directory');
    await expect(runExport(ctx.db, { outDir: join(filePath, 'sub'), format: 'jsonl' })).rejects.toThrow();
  });
});

describe('runExport — 5k golden round-trip', () => {
  let ctx: TestDb;
  let dir: string;

  beforeAll(async () => {
    const goldenDir = resolve(repoRoot, 'fixtures/out/golden');
    if (!existsSync(resolve(goldenDir, 'leads.json'))) {
      execFileSync('node', [resolve(repoRoot, 'fixtures/src/cli.ts'), '--golden'], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
    }
    ctx = await createTestDb();
    dir = await mkdtemp(join(tmpdir(), 'sb-export-5k-'));
    await loadGoldenFixtures(ctx.db);
    // Catalog a couple of lead custom fields so flattening runs at scale too.
    await ctx.db.insert(customFieldDefs).values([
      { entity: 'lead', key: 'industry', label: 'Industry', type: 'select' },
      { entity: 'lead', key: 'employees', label: 'Employees', type: 'number' },
    ]);
  }, 300_000);

  afterAll(async () => {
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('exported row counts match the DB exactly', async () => {
    const manifest = await runExport(ctx.db, { outDir: dir, format: 'jsonl', batchSize: 500 });

    expect(byName(manifest, 'leads').rows).toBe(5000);
    expect(byName(manifest, 'contacts').rows).toBe(9988);
    expect(byName(manifest, 'opportunities').rows).toBe(2052);
    expect(byName(manifest, 'tasks').rows).toBe(1442);
    expect(byName(manifest, 'activities').rows).toBe(62792);
    expect(byName(manifest, 'users').rows).toBeGreaterThan(0);

    // File line counts agree with the manifest (streaming wrote every row).
    expect(await countLines(join(dir, 'leads.jsonl'))).toBe(5000);
    expect(await countLines(join(dir, 'activities.jsonl'))).toBe(62792);
  }, 120_000);

  test('a spot-checked lead row matches the DB', async () => {
    await runExport(ctx.db, { outDir: dir, format: 'jsonl', batchSize: 500 });
    const line = await firstLine(join(dir, 'leads.jsonl'));
    const exported = JSON.parse(line) as Record<string, unknown>;

    const [dbLead] = await ctx.db
      .select()
      .from(leads)
      .where(eq(leads.id, String(exported['id'])));
    expect(dbLead).toBeDefined();
    expect(exported['name']).toBe(dbLead?.name);
    expect(exported['custom']).toEqual(dbLead?.custom);
    expect(exported['dnc']).toBe(dbLead?.dnc);
  }, 120_000);
});
