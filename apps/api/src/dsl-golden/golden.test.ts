/**
 * DSL golden set (Task 1d): ≥60 golden DSL queries executed end-to-end —
 * parse → compile (fixed ctx) → run on PGlite against the loaded 5k golden
 * fixture — with expected lead-id sets derived INDEPENDENTLY by the TS
 * reference evaluator over the same fixture data (never compiler snapshots).
 *
 * Fixed execution context (per task spec): currentUserId = a fixture owner,
 * orgTimezone = America/New_York, now = 2026-06-03T15:30:00Z (fixed instant two
 * days after the fixture REFERENCE_MS so `within`/named anchors are
 * non-degenerate), fieldCatalog = the fixture's custom field defs.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compile,
  parse,
  type Ast,
  type CompileContext,
  type CompileOptions,
  type Cursor,
  type DslCustomFieldDef,
  type Relative,
} from '@switchboard/shared/dsl';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { sequences, sequenceEnrollments } from '../db/index.ts';
import { loadGoldenFixtures } from '../services/fixtures/loader.ts';
import { buildCases, type DerivedValues } from './cases.ts';
import {
  ReferenceEvaluator,
  resolveReldateInstant,
  type RefActivity,
  type RefContact,
  type RefContext,
  type RefDataset,
  type RefEnrollment,
  type RefLead,
  type RefOpportunity,
} from './reference.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const goldenDir = resolve(repoRoot, 'fixtures/out/golden');

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(goldenDir, file), 'utf8')) as T;
}

// --- Fixture data (module scope: cases are built at collection time) ---------

const leadRows = readJson<RefLead[]>('leads.json');
const contactRows = readJson<RefContact[]>('contacts.json');
const oppRows = readJson<RefOpportunity[]>('opportunities.json');
const activityRows = readJson<RefActivity[]>('activities.json');

const firstLead = leadRows[0];
const firstOpp = oppRows[0];
const firstContact = contactRows[0];
const firstEmail = firstContact?.emails[0]?.email;
if (!firstLead || !firstOpp || !firstContact || firstEmail === undefined) {
  throw new Error('golden fixture is empty — run `pnpm fixtures:generate --golden`');
}
const otherLead = leadRows.find((l) => l.ownerId !== firstLead.ownerId);
if (!otherLead) throw new Error('golden fixture has a single owner — cannot derive otherOwnerId');
if (!Number.isInteger(firstOpp.valueCents / 100)) {
  throw new Error('fixture opportunity value is not whole dollars');
}

const derived: DerivedValues = {
  meOwnerId: firstLead.ownerId,
  otherOwnerId: otherLead.ownerId,
  exactValueDollars: firstOpp.valueCents / 100,
  exactEmail: firstEmail,
  exactEmployees: Number(firstLead.custom.employees),
};

const CASES = buildCases(derived);

// --- Fixed execution context --------------------------------------------------

const NOW = new Date('2026-06-03T15:30:00.000Z'); // Wednesday; EDT = UTC-4
const ORG_TZ = 'America/New_York';

/** The fixture's custom field defs (C1 `custom_field_defs` shape, lead entity). */
const FIELD_CATALOG: DslCustomFieldDef[] = [
  { key: 'industry', entity: 'lead', type: 'select' },
  { key: 'tier', entity: 'lead', type: 'text' },
  { key: 'employees', entity: 'lead', type: 'number' },
  { key: 'renewal_date', entity: 'lead', type: 'date' },
  { key: 'csm', entity: 'lead', type: 'user' },
];

const ctx: CompileContext = {
  currentUserId: derived.meOwnerId,
  orgTimezone: ORG_TZ,
  fieldCatalog: FIELD_CATALOG,
  now: NOW,
};

const refCtx: RefContext = {
  currentUserId: derived.meOwnerId,
  orgTimezone: ORG_TZ,
  now: NOW,
};

// --- Seeded sequence enrollments (fixtures carry none; deterministic plan) ----

const RECENT_ENROLLED_AT = '2026-05-28T12:00:00.000Z'; // within 2w of NOW
const OLD_ENROLLED_AT = '2026-04-01T12:00:00.000Z'; // outside 2w of NOW

interface EnrollmentSeed extends RefEnrollment {
  contactId: string;
}

function buildEnrollmentPlan(): EnrollmentSeed[] {
  const firstContactByLead = new Map<string, string>();
  for (const c of contactRows) {
    if (!firstContactByLead.has(c.leadId)) firstContactByLead.set(c.leadId, c.id);
  }
  const plan: EnrollmentSeed[] = [];
  leadRows.forEach((lead, i) => {
    const contactId = firstContactByLead.get(lead.id);
    if (contactId === undefined) return; // every fixture lead has ≥1 contact
    const createdAt = i % 2 === 0 ? RECENT_ENROLLED_AT : OLD_ENROLLED_AT;
    if (i % 7 === 0) {
      plan.push({
        leadId: lead.id,
        contactId,
        sequenceName: 'Onboarding',
        state: i % 21 === 0 ? 'finished' : i % 14 === 0 ? 'paused' : 'active',
        createdAt,
      });
    }
    if (i % 11 === 0) {
      plan.push({
        leadId: lead.id,
        contactId,
        sequenceName: 'Renewal Push',
        state: i % 33 === 0 ? 'unenrolled' : 'active',
        createdAt,
      });
    }
  });
  return plan;
}

const ENROLLMENT_PLAN = buildEnrollmentPlan();

// --- Reference evaluator --------------------------------------------------------

const refDataset: RefDataset = {
  leads: leadRows,
  contacts: contactRows,
  opportunities: oppRows,
  activities: activityRows,
};
const reference = new ReferenceEvaluator(refDataset, refCtx, ENROLLMENT_PLAN);

// Sort-cursor lookups (fetchAll pages on the default `created desc` sort).
const createdById = new Map<string, string>(leadRows.map((l) => [l.id, l.createdAt]));
const nameById = new Map<string, string>(leadRows.map((l) => [l.id, l.name]));

// --- Suite ------------------------------------------------------------------------

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
  // Pin the session timezone: absolute date literals (`created > 2025-01-01`)
  // cast to timestamptz in the session zone; the reference interprets them as
  // UTC midnight. C3 does not pin this — see task report (friction).
  await tdb.client.exec(`SET TIME ZONE 'UTC'`);
  await loadGoldenFixtures(tdb.db);

  // Seed sequences + enrollments for in_sequence(...) coverage.
  const onboardingId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const renewalId = 'aaaaaaaa-0000-4000-8000-000000000002';
  const seqIdByName = new Map<string, string>([
    ['Onboarding', onboardingId],
    ['Renewal Push', renewalId],
  ]);
  await tdb.db.insert(sequences).values([
    { id: onboardingId, name: 'Onboarding', status: 'active' },
    { id: renewalId, name: 'Renewal Push', status: 'active' },
  ]);
  const rows = ENROLLMENT_PLAN.map((e) => {
    const sequenceId = seqIdByName.get(e.sequenceName);
    if (sequenceId === undefined) throw new Error(`unknown sequence ${e.sequenceName}`);
    return {
      sequenceId,
      leadId: e.leadId,
      contactId: e.contactId,
      state: e.state,
      createdAt: e.createdAt,
    };
  });
  for (let i = 0; i < rows.length; i += 500) {
    await tdb.db.insert(sequenceEnrollments).values(rows.slice(i, i + 500));
  }
}, 300_000);

afterAll(async () => {
  await tdb.close();
});

/** Page through the compiled query with keyset cursors until exhausted. */
async function fetchAllIds(ast: Ast): Promise<string[]> {
  const ids: string[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const options: CompileOptions = cursor ? { limit: 200, cursor } : { limit: 200 };
    const { sql, params } = compile(ast, ctx, options);
    const res = await tdb.client.query<{ id: string }>(sql, params);
    for (const row of res.rows) ids.push(row.id);
    if (res.rows.length < 200) return ids;
    const last = res.rows[res.rows.length - 1];
    if (last === undefined) return ids;
    const createdAt = createdById.get(last.id);
    if (createdAt === undefined) throw new Error(`fetchAllIds: unknown lead id ${last.id}`);
    cursor = { sortValue: createdAt, id: last.id };
  }
}

function expectSameSet(actual: Set<string>, expected: Set<string>): void {
  const actualOnly = [...actual].filter((x) => !expected.has(x)).slice(0, 5);
  const expectedOnly = [...expected].filter((x) => !actual.has(x)).slice(0, 5);
  expect({ size: actual.size, actualOnly, expectedOnly }).toEqual({
    size: expected.size,
    actualOnly: [],
    expectedOnly: [],
  });
}

describe('reference evaluator anchors (fixed ctx sanity pins)', () => {
  const anchor = (rel: Relative): string => new Date(resolveReldateInstant(rel, refCtx)).toISOString();
  it('pins today / this_week / this_month for the fixed now in America/New_York', () => {
    expect(anchor({ form: 'named', name: 'today' })).toBe('2026-06-03T04:00:00.000Z');
    expect(anchor({ form: 'named', name: 'this_week' })).toBe('2026-06-01T04:00:00.000Z');
    expect(anchor({ form: 'named', name: 'this_month' })).toBe('2026-06-01T04:00:00.000Z');
    expect(anchor({ form: 'relative', n: 2, unit: 'w' })).toBe('2026-05-20T15:30:00.000Z');
    expect(anchor({ form: 'relative', n: 2, unit: 'mo' })).toBe('2026-04-03T15:30:00.000Z');
  });
});

describe(`DSL golden set — ${CASES.length} reference-derived cases on the 5k fixture`, () => {
  it('has at least 60 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
  });

  for (const c of CASES) {
    it(
      c.name,
      async () => {
        const ast = parse(c.dsl, { fieldCatalog: FIELD_CATALOG });
        const expected = reference.evaluate(ast);

        // Degeneracy guards: goldens must exercise what they claim to.
        if (c.expectEmpty === true) {
          expect(expected.size).toBe(0);
        } else if (c.expectFull === true) {
          expect(expected.size).toBe(leadRows.length);
        } else {
          expect(expected.size).toBeGreaterThan(0);
          expect(expected.size).toBeLessThan(leadRows.length);
        }

        const ids = await fetchAllIds(ast);
        // Keyset pagination never yields a row twice.
        expect(new Set(ids).size).toBe(ids.length);
        expectSameSet(new Set(ids), expected);
      },
      60_000,
    );
  }
});

describe('keyset pagination + sort options (DB order is ground truth)', () => {
  const FILTER = 'status = "Won" and custom.industry = "media"';
  let ast: Ast;

  beforeAll(() => {
    ast = parse(FILTER, { fieldCatalog: FIELD_CATALOG });
  });

  async function run(options: CompileOptions): Promise<string[]> {
    const { sql, params } = compile(ast, ctx, options);
    const res = await tdb.client.query<{ id: string }>(sql, params);
    return res.rows.map((r) => r.id);
  }

  it(
    'page1+page2 are disjoint and equal the unpaginated prefix (created desc)',
    async () => {
      const all = await run({ limit: 200 });
      expect(all.length).toBeGreaterThan(60); // needs ≥3 pages of 30 to be meaningful
      expect(all.length).toBeLessThan(200); // one-shot list is complete

      // The filtered set itself matches the reference.
      expectSameSet(new Set(all), reference.evaluate(ast));

      const page1 = await run({ limit: 30 });
      const lastP1 = page1[page1.length - 1];
      expect(lastP1).toBeDefined();
      if (lastP1 === undefined) return;
      const c1 = createdById.get(lastP1);
      if (c1 === undefined) throw new Error('missing createdAt');
      const page2 = await run({ limit: 30, cursor: { sortValue: c1, id: lastP1 } });

      expect(page1).toEqual(all.slice(0, 30));
      expect(page2).toEqual(all.slice(30, 60));
      expect(page1.filter((id) => page2.includes(id))).toEqual([]);
    },
    60_000,
  );

  it(
    'order is stable across repeated execution',
    async () => {
      const a = await run({ limit: 200 });
      const b = await run({ limit: 200 });
      expect(a).toEqual(b);
    },
    60_000,
  );

  it(
    'sort by name asc paginates consistently with its own unpaginated order',
    async () => {
      const sort = { field: 'name', direction: 'asc' } as const;
      const all = await run({ limit: 200, sort });
      expectSameSet(new Set(all), reference.evaluate(ast)); // sort never changes the set

      const page1 = await run({ limit: 25, sort });
      const lastP1 = page1[page1.length - 1];
      expect(lastP1).toBeDefined();
      if (lastP1 === undefined) return;
      const n1 = nameById.get(lastP1);
      if (n1 === undefined) throw new Error('missing name');
      const page2 = await run({ limit: 25, sort, cursor: { sortValue: n1, id: lastP1 } });

      expect(page1).toEqual(all.slice(0, 25));
      expect(page2).toEqual(all.slice(25, 50));
    },
    60_000,
  );

  it(
    'sort by updated desc returns the same set (order backed by load-time column)',
    async () => {
      const all = await run({ limit: 200, sort: { field: 'updated', direction: 'desc' } });
      expectSameSet(new Set(all), reference.evaluate(ast));
    },
    60_000,
  );

  it(
    'keyword case-insensitive twin queries yield identical sets',
    async () => {
      const lower = await fetchAllIds(parse('no call within 30 d', { fieldCatalog: FIELD_CATALOG }));
      const upper = await fetchAllIds(parse('NO CALL WITHIN 30 D', { fieldCatalog: FIELD_CATALOG }));
      expect(new Set(upper)).toEqual(new Set(lower));
    },
    60_000,
  );
});
