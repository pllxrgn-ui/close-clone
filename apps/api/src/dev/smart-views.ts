import { parse, type DslCustomFieldDef } from '@switchboard/shared';

import { smartViews, type Db } from '../db/index.ts';

/**
 * Smart-view DEV seed. The real Smart View CRUD + preview now lives in
 * `routes/smart-views.ts` (the production route the web binds to in real mode);
 * the old dev preview shim was removed as superseded. All that remains here is
 * the demo-view seed + the minimal raw-SQL runner type the dev boot passes to the
 * real smart-views/bulk routes (the compiler emits `$n` params).
 */

/** Minimal raw-SQL runner (the PGlite client); the compiler emits `$n` params. */
export interface RawQueryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// Empty custom-field catalog: the fixture exposes no catalogued custom fields,
// so `custom.<key>` predicates are (correctly) rejected at parse time here.
const FIELD_CATALOG: readonly DslCustomFieldDef[] = [];

// Deterministic ids/timestamps keep every boot byte-identical (no wall-clock in
// seeding). These mirror W1's fixture set so the demo opens on familiar views.
const SEED_TS = '2026-01-01T00:00:00.000Z';
const SEED_VIEWS: ReadonlyArray<{ id: string; name: string; dsl: string; shared: boolean }> = [
  {
    id: '5e1d0000-0000-4000-8000-000000000001',
    name: 'My open leads',
    dsl: 'owner in (me) and status != "Won" and status != "Lost"',
    shared: false,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000002',
    name: 'Overdue follow-ups',
    dsl: 'next_task_due < today',
    shared: true,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000003',
    name: 'New replies (48h)',
    dsl: 'has inbound_email within 2 d',
    shared: true,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000004',
    name: 'In onboarding sequence',
    dsl: 'has in_sequence("Onboarding")',
    shared: true,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000005',
    name: 'Do not contact',
    dsl: 'dnc = true',
    shared: true,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000006',
    name: 'High-value opportunities',
    dsl: 'opportunity.value > 5000',
    shared: false,
  },
  {
    id: '5e1d0000-0000-4000-8000-000000000007',
    name: 'Recently contacted',
    dsl: 'last_contacted > 7 d ago',
    shared: false,
  },
];

/** Seed the smart_views table with the demo views (idempotent, deterministic). */
export async function seedDevSmartViews(db: Db): Promise<void> {
  const rows = SEED_VIEWS.map((s) => ({
    id: s.id,
    name: s.name,
    ownerId: null,
    shared: s.shared,
    dsl: s.dsl,
    ast: parse(s.dsl, { fieldCatalog: FIELD_CATALOG }) as unknown as Record<string, unknown>,
    sort: { field: 'last_contacted', dir: 'desc' } as Record<string, unknown>,
    columns: ['name', 'status', 'owner', 'last_contacted', 'next_task_due'] as unknown[],
    createdAt: SEED_TS,
    updatedAt: SEED_TS,
  }));
  await db.insert(smartViews).values(rows).onConflictDoNothing();
}
