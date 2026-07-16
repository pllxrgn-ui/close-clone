import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { imports, leads, users, type Db } from '../../db/index.ts';
import {
  AlreadyCommittedError,
  CommitInProgressError,
  ImportNotCommittableError,
  commitImport,
} from './commit.ts';
import { emptyCounts, type ImportPlan, type RowPlan } from './types.ts';

/**
 * Transactional committer (Task 4f) against PGlite: leads/contacts/custom values
 * written, import_created + lead_created emitted exactly once per created lead,
 * status transitions, idempotent re-commit (CONFLICT), crash/resume from the
 * checkpoint without duplicates, and graceful failure.
 */

const USER = '00000000-0000-4000-8000-0000000000c1';

let ctx: TestDb;

async function seedUser(db: Db): Promise<void> {
  await db.insert(users).values({
    id: USER,
    email: 'importer@example.com',
    name: 'Importer',
    role: 'admin',
    idpSubject: 'idp|committer',
  });
}

function createRow(
  rowIndex: number,
  opts: { name: string; url?: string | null; custom?: Record<string, unknown>; email?: string },
): RowPlan {
  const leadId = randomUUID();
  const hasContact = opts.email !== undefined;
  return {
    rowIndex,
    outcome: 'create',
    action: null,
    matchType: null,
    leadCreated: true,
    contactCreated: hasContact,
    targetLeadId: leadId,
    lead: {
      id: leadId,
      name: opts.name,
      url: opts.url ?? null,
      description: null,
      dnc: false,
      statusId: null,
      ownerId: null,
      custom: opts.custom ?? {},
    },
    contact: hasContact
      ? {
          id: randomUUID(),
          name: opts.name,
          title: null,
          email: opts.email ?? null,
          phone: null,
          suppressed: false,
        }
      : null,
    errors: [],
    suppressedEmails: [],
  };
}

function planOf(rows: RowPlan[]): ImportPlan {
  const counts = emptyCounts();
  counts.totalRows = rows.length;
  for (const r of rows) {
    if (r.outcome === 'create') {
      counts.leadsCreated += 1;
      if (r.contactCreated) counts.contactsCreated += 1;
    }
  }
  return { version: 1, counts, rows, warnings: [] };
}

async function insertImport(db: Db, plan: ImportPlan, status = 'dry_run'): Promise<string> {
  const [row] = await db
    .insert(imports)
    .values({
      createdBy: USER,
      filename: 'leads.csv',
      fileRef: 'x.csv',
      rowCount: plan.rows.length,
      status: status as 'dry_run',
      dryRunResult: plan as unknown as Record<string, unknown>,
    })
    .returning({ id: imports.id });
  if (!row) throw new Error('insert import failed');
  return row.id;
}

async function count(db: Db, table: string, where = 'true'): Promise<number> {
  const r = await db.execute(sql.raw(`select count(*)::int as n from ${table} where ${where}`));
  return (r as { rows: { n: number }[] }).rows[0]?.n ?? -1;
}

async function statusOf(db: Db, importId: string): Promise<string> {
  const [row] = await db
    .select({ status: imports.status })
    .from(imports)
    .where(sql`${imports.id} = ${importId}`);
  return row?.status ?? 'missing';
}

beforeEach(async () => {
  ctx = await createTestDb();
  await seedUser(ctx.db);
}, 60_000);

afterEach(async () => {
  await ctx.close();
});

describe('commitImport — fresh commit', () => {
  test('creates leads + contacts and emits import_created + lead_created once each', async () => {
    const id = await insertImport(
      ctx.db,
      planOf([
        createRow(1, { name: 'Acme', url: 'https://acme.com', email: 'a@acme.com', custom: { tier: 'Gold' } }),
        createRow(2, { name: 'Globex', email: 'b@globex.io' }),
        createRow(3, { name: 'Initech' }),
      ]),
    );

    const outcome = await commitImport(ctx.db, id);
    expect(outcome.status).toBe('committed');
    expect(outcome.counters).toEqual({ leads: 3, contacts: 2, merged: 0, activities: 6 });

    expect(await statusOf(ctx.db, id)).toBe('committed');
    expect(await count(ctx.db, 'leads')).toBe(3);
    expect(await count(ctx.db, 'contacts')).toBe(2);
    expect(await count(ctx.db, 'activities', "type = 'import_created'")).toBe(3);
    expect(await count(ctx.db, 'activities', "type = 'lead_created'")).toBe(3);

    // Custom value written typed.
    const [acme] = await ctx.db
      .select({ custom: leads.custom })
      .from(leads)
      .where(sql`${leads.name} = 'Acme'`);
    expect(acme?.custom).toEqual({ tier: 'Gold' });

    // Activities are attributed to the import creator.
    expect(await count(ctx.db, 'activities', `user_id = '${USER}'`)).toBe(6);
  });
});

describe('commitImport — idempotency (CONFLICT, never duplicate rows)', () => {
  test('re-committing a committed import throws AlreadyCommittedError and writes nothing new', async () => {
    const id = await insertImport(ctx.db, planOf([createRow(1, { name: 'Acme', email: 'a@acme.com' })]));
    await commitImport(ctx.db, id);
    expect(await count(ctx.db, 'leads')).toBe(1);

    await expect(commitImport(ctx.db, id)).rejects.toBeInstanceOf(AlreadyCommittedError);
    expect(await count(ctx.db, 'leads')).toBe(1);
    expect(await count(ctx.db, 'activities')).toBe(2);
  });

  test('committing while a fresh lease is held throws CommitInProgressError', async () => {
    const plan = planOf([createRow(1, { name: 'Acme' })]);
    const id = await insertImport(ctx.db, plan);
    // Put it into 'committing' with a fresh lease from another committer.
    await ctx.db
      .update(imports)
      .set({
        status: 'committing',
        result: {
          status: 'in_progress',
          nextRowIndex: 0,
          counters: { leads: 0, contacts: 0, merged: 0, activities: 0 },
          lease: { committerId: 'worker-A', heartbeatAt: new Date().toISOString() },
          startedAt: new Date().toISOString(),
          finishedAt: null,
          error: null,
        },
      })
      .where(sql`${imports.id} = ${id}`);

    await expect(
      commitImport(ctx.db, id, { committerId: 'worker-B', leaseTtlMs: 60_000 }),
    ).rejects.toBeInstanceOf(CommitInProgressError);
  });

  test('rejects committing an import that has not been dry-run', async () => {
    const [row] = await ctx.db
      .insert(imports)
      .values({ createdBy: USER, filename: 'f.csv', fileRef: 'r', status: 'uploaded' })
      .returning({ id: imports.id });
    await expect(commitImport(ctx.db, row?.id ?? '')).rejects.toBeInstanceOf(ImportNotCommittableError);
  });
});

describe('commitImport — crash/resume from checkpoint', () => {
  test('resumes after a simulated crash without duplicating rows or events', async () => {
    const rows = Array.from({ length: 5 }, (_v, i) =>
      createRow(i + 1, { name: `Co${i}`, email: `c${i}@co${i}.com` }),
    );
    const id = await insertImport(ctx.db, planOf(rows));

    // Simulated crash: process one batch (2 rows) then stop, leaving 'committing'.
    const partial = await commitImport(ctx.db, id, {
      batchSize: 2,
      stopAfterBatches: 1,
      committerId: 'worker-1',
    });
    expect(partial.status).toBe('stopped');
    expect(partial.nextRowIndex).toBe(2);
    expect(await statusOf(ctx.db, id)).toBe('committing');
    expect(await count(ctx.db, 'leads')).toBe(2);

    // Resume (same committer) → completes.
    const done = await commitImport(ctx.db, id, { batchSize: 2, committerId: 'worker-1' });
    expect(done.status).toBe('committed');
    expect(done.resumed).toBe(true);
    expect(done.counters.leads).toBe(5);

    expect(await statusOf(ctx.db, id)).toBe('committed');
    expect(await count(ctx.db, 'leads')).toBe(5);
    expect(await count(ctx.db, 'contacts')).toBe(5);
    expect(await count(ctx.db, 'activities', "type = 'lead_created'")).toBe(5);
    expect(await count(ctx.db, 'activities', "type = 'import_created'")).toBe(5);
  });

  test('a stale lease lets a different committer take over and resume', async () => {
    const rows = Array.from({ length: 4 }, (_v, i) => createRow(i + 1, { name: `Co${i}` }));
    const id = await insertImport(ctx.db, planOf(rows));
    await commitImport(ctx.db, id, { batchSize: 2, stopAfterBatches: 1, committerId: 'worker-1' });

    // worker-2 with a short TTL sees the lease as stale and resumes.
    const done = await commitImport(ctx.db, id, {
      batchSize: 2,
      committerId: 'worker-2',
      leaseTtlMs: 0,
    });
    expect(done.status).toBe('committed');
    expect(await count(ctx.db, 'leads')).toBe(4);
  });
});

describe('commitImport — merge-fields', () => {
  test('fills empty lead fields + attaches a contact without emitting lead_created', async () => {
    const existingLeadId = randomUUID();
    await ctx.db.insert(leads).values({ id: existingLeadId, name: 'Acme', url: null, custom: { a: 1 } });

    const mergeRow: RowPlan = {
      rowIndex: 1,
      outcome: 'dedupe',
      action: 'merge-fields',
      matchType: 'domain',
      leadCreated: false,
      contactCreated: true,
      targetLeadId: existingLeadId,
      lead: {
        id: existingLeadId,
        name: 'Acme',
        url: 'https://acme.com',
        description: 'filled in',
        dnc: false,
        statusId: null,
        ownerId: null,
        custom: { b: 2 },
      },
      contact: {
        id: randomUUID(),
        name: 'New Person',
        title: null,
        email: 'new@acme.com',
        phone: null,
        suppressed: false,
      },
      errors: [],
      suppressedEmails: [],
    };
    const plan: ImportPlan = { version: 1, counts: emptyCounts(), rows: [mergeRow], warnings: [] };
    const id = await insertImport(ctx.db, plan);

    const outcome = await commitImport(ctx.db, id);
    expect(outcome.counters).toEqual({ leads: 0, contacts: 1, merged: 1, activities: 0 });

    const [merged] = await ctx.db
      .select({ url: leads.url, description: leads.description, custom: leads.custom })
      .from(leads)
      .where(sql`${leads.id} = ${existingLeadId}`);
    expect(merged?.url).toBe('https://acme.com'); // was null → filled
    expect(merged?.description).toBe('filled in');
    expect(merged?.custom).toEqual({ a: 1, b: 2 }); // existing key kept, new key added

    expect(await count(ctx.db, 'leads')).toBe(1); // no new lead
    expect(await count(ctx.db, 'contacts')).toBe(1);
    expect(await count(ctx.db, 'activities')).toBe(0); // merge emits no lead_created/import_created
  });
});

describe('commitImport — graceful failure', () => {
  test('a batch error marks the import failed and keeps prior batches committed', async () => {
    const good = createRow(1, { name: 'Good' });
    const bad = createRow(2, { name: 'Bad' });
    // Point the second lead at a non-existent owner → FK violation on insert.
    if (bad.lead) bad.lead.ownerId = '00000000-0000-4000-8000-0000000000ff';
    const id = await insertImport(ctx.db, planOf([good, bad]));

    await expect(commitImport(ctx.db, id, { batchSize: 1 })).rejects.toThrow();
    expect(await statusOf(ctx.db, id)).toBe('failed');
    expect(await count(ctx.db, 'leads')).toBe(1); // first batch persisted, second rolled back
  });
});
