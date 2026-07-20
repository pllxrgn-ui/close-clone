import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createTestDb, type TestDb } from './test-helpers.ts';

/**
 * Task 1c — index migration (0002) assertions.
 *
 * `createTestDb` applies migrations 0000 → 0002 from an empty PGlite database,
 * so the suite passing at all proves the chain applies cleanly from scratch.
 * The tests then assert the ARCHITECTURE §9 indexes exist with the intended
 * shape (partial predicates, GIN methods) via pg_indexes, and — best-effort —
 * that the planner actually picks the timeline covering index for the hot
 * timeline read (plan shapes are engine-dependent, so only that one stable
 * case is pinned).
 */

interface IndexRow {
  indexname: string;
  indexdef: string;
}

let ctx: TestDb;
const byTable = new Map<string, IndexRow[]>();

async function indexesOf(table: string): Promise<IndexRow[]> {
  const cached = byTable.get(table);
  if (cached) return cached;
  const { rows } = await ctx.client.query<IndexRow>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table],
  );
  byTable.set(table, rows);
  return rows;
}

function def(rows: IndexRow[], name: string): string {
  const row = rows.find((r) => r.indexname === name);
  expect(row, `index "${name}" should exist`).toBeDefined();
  return (row as IndexRow).indexdef;
}

beforeAll(async () => {
  ctx = await createTestDb();
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

describe('migration chain 0000→0003', () => {
  test('all seven migrations are journaled as applied', async () => {
    const { rows } = await ctx.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    // 0000-0003 (core) + 0010 (imports, Task 4f) + 0011 (audit append-only, Task 5b)
    // + 0012 (per-lead / keyset read-path indexes, perf hardening).
    expect(rows[0]?.n).toBe(7);
  });
});

describe('per-lead + keyset read-path indexes (migration 0012)', () => {
  test('opportunities has a btree on lead_id', async () => {
    const d = def(await indexesOf('opportunities'), 'opportunities_lead_id_idx');
    expect(d).toContain('USING btree');
    expect(d).toContain('lead_id');
  });

  test('notes has a btree on lead_id', async () => {
    const d = def(await indexesOf('notes'), 'notes_lead_id_idx');
    expect(d).toContain('USING btree');
    expect(d).toContain('lead_id');
  });

  test('email_threads has a partial btree on lead_id WHERE lead_id IS NOT NULL', async () => {
    const d = def(await indexesOf('email_threads'), 'email_threads_lead_id_idx');
    expect(d).toContain('USING btree');
    expect(d).toContain('lead_id');
    expect(d.toLowerCase()).toContain('where (lead_id is not null)');
  });

  test('email_messages has a btree on (thread_id, direction, sent_at DESC)', async () => {
    const d = def(await indexesOf('email_messages'), 'email_messages_thread_dir_sent_idx');
    expect(d).toContain('USING btree');
    expect(d).toContain('thread_id');
    expect(d).toContain('direction');
    expect(d).toContain('sent_at DESC');
  });

  test('leads has a partial keyset index (created_at DESC, id DESC) WHERE deleted_at IS NULL', async () => {
    const d = def(await indexesOf('leads'), 'leads_created_id_live_idx');
    expect(d).toContain('USING btree');
    expect(d).toContain('created_at DESC');
    expect(d).toContain('id DESC');
    expect(d.toLowerCase()).toContain('where (deleted_at is null)');
  });
});

describe('leads denormalized hot-column indexes (partial on live set)', () => {
  const partials = [
    ['leads_last_contacted_at_idx', 'last_contacted_at'],
    ['leads_last_inbound_at_idx', 'last_inbound_at'],
    ['leads_next_task_due_at_idx', 'next_task_due_at'],
    ['leads_last_call_at_idx', 'last_call_at'],
    ['leads_last_email_at_idx', 'last_email_at'],
    ['leads_last_sms_at_idx', 'last_sms_at'],
  ] as const;

  test.each(partials)('%s is a btree on %s partial WHERE deleted_at IS NULL', async (name, col) => {
    const d = def(await indexesOf('leads'), name);
    expect(d).toContain('USING btree');
    expect(d).toContain(col);
    expect(d.toLowerCase()).toContain('where (deleted_at is null)');
  });

  test('leads.custom has a jsonb_path_ops GIN index', async () => {
    const d = def(await indexesOf('leads'), 'leads_custom_gin_idx');
    expect(d).toContain('USING gin');
    expect(d).toContain('jsonb_path_ops');
  });

  test('leads.search_tsv has a GIN index', async () => {
    const d = def(await indexesOf('leads'), 'leads_search_tsv_gin_idx');
    expect(d).toContain('USING gin');
    expect(d).toContain('search_tsv');
  });
});

describe('activity / inbox / compliance indexes', () => {
  test('activities timeline covering index (lead_id, occurred_at DESC, id)', async () => {
    const d = def(await indexesOf('activities'), 'activities_lead_occurred_idx');
    expect(d).toContain('lead_id');
    expect(d).toContain('occurred_at DESC');
    expect(d).toContain('id');
  });

  test('activities type-filtered index (lead_id, type, occurred_at DESC)', async () => {
    const d = def(await indexesOf('activities'), 'activities_lead_type_occurred_idx');
    expect(d).toContain('lead_id');
    expect(d).toContain('type');
    expect(d).toContain('occurred_at DESC');
  });

  test('tasks open-set partial index (assignee_id, due_at) WHERE completed_at IS NULL', async () => {
    const d = def(await indexesOf('tasks'), 'tasks_open_due_idx');
    expect(d).toContain('assignee_id');
    expect(d).toContain('due_at');
    expect(d.toLowerCase()).toContain('where (completed_at is null)');
  });

  test('email_threads triage partial index on the ambiguous set', async () => {
    const d = def(await indexesOf('email_threads'), 'email_threads_triage_idx');
    expect(d).toContain('triage_status');
    expect(d.toLowerCase()).toContain("where (triage_status = 'ambiguous'");
  });

  test('send_intents sweeper index (state, due_at)', async () => {
    const d = def(await indexesOf('send_intents'), 'send_intents_state_due_idx');
    expect(d).toContain('state');
    expect(d).toContain('due_at');
  });

  test('suppressions active-lookup partial index (kind, value) WHERE released_at IS NULL', async () => {
    const d = def(await indexesOf('suppressions'), 'suppressions_active_lookup_idx');
    expect(d).toContain('kind');
    expect(d).toContain('value');
    expect(d.toLowerCase()).toContain('where (released_at is null)');
  });
});

describe('planner smoke (best-effort EXPLAIN)', () => {
  test('timeline read is index-backed (no seq scan)', async () => {
    // Enough rows that the planner prefers the index over a seq scan.
    await ctx.client.exec(`
      INSERT INTO leads (id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'Plan Lead');
      INSERT INTO activities (lead_id, type, occurred_at)
      SELECT '00000000-0000-4000-8000-000000000001', 'note_added', now() - (g || ' minutes')::interval
      FROM generate_series(1, 500) AS g;
      ANALYZE activities;
    `);
    const { rows } = await ctx.client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id, type, occurred_at FROM activities
       WHERE lead_id = '00000000-0000-4000-8000-000000000001'
       ORDER BY occurred_at DESC, id DESC LIMIT 50`,
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    // Best-effort: the planner may pick either lead-scoped activities index
    // (plain index scan or bitmap) depending on stats — assert index-backed
    // access rather than pinning one plan shape.
    expect(plan).toMatch(/activities_lead_(occurred|type_occurred)_idx/);
    expect(plan).not.toContain('Seq Scan on activities');
  });
});
