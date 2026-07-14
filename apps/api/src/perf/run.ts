/**
 * Latency harness (Task 1c / ARCHITECTURE §9 — the 150ms p95 budget).
 *
 * Loads the 100k latency fixture into a database and times a set of
 * representative reads (Smart Views compiled through the *real* DSL compiler,
 * plus the timeline / inbox / search / detail read paths), reporting p50/p95/p99
 * per query.
 *
 * Authority (DECISIONS D-003): the gate is authoritative **only** against real
 * Postgres. Set `DATABASE_URL` and the harness connects there and fails the
 * build (exit 1) when any core p95 exceeds the budget. Without `DATABASE_URL`
 * it runs on in-process PGlite as a smoke check, clearly labelled
 * NON-AUTHORITATIVE, and never fails the build on timings (PGlite/WASM latency
 * is not comparable to server Postgres).
 *
 * Executed by Node directly (`scripts/perf.mjs`). The shared DSL compiler uses a
 * TS parameter property, so the runner is launched with
 * `--experimental-transform-types`; this file itself stays erasable-syntax only.
 */
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool as PgPool } from 'pg';

import {
  parse,
  compile,
  type CompileContext,
  type CompiledQuery,
  type DslCustomFieldDef,
  type SortSpec,
} from '@switchboard/shared';

import type { Db } from '../db/index.ts';
import { fixturesPresent, loadLatencyFixtures } from '../services/fixtures/loader.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '../db/migrations');
const REPO_ROOT = resolve(HERE, '../../../..');
const LATENCY_DIR = resolve(REPO_ROOT, 'fixtures/out/latency');

/** Core p95 budget (ARCHITECTURE §9). */
const BUDGET_MS = 150;
const WARMUP = 5;
const ITERS = envInt('PERF_ITERS', 60);
/** PGlite (non-authoritative) loads a bounded slice so the smoke run is quick;
 *  real Postgres loads the whole 100k set. Override with PERF_MAX_LEADS. */
const DEFAULT_PGLITE_LEADS = 10_000;

// --- Query result / driver plumbing ----------------------------------------

interface QueryResult {
  readonly rows: readonly unknown[];
}
type RawQuery = (sql: string, params: readonly unknown[]) => Promise<QueryResult>;

interface Backend {
  readonly db: Db;
  readonly query: RawQuery;
  readonly authoritative: boolean;
  readonly label: string;
  readonly maxLeads: number;
  close: () => Promise<void>;
}

async function makeBackend(): Promise<Backend> {
  const url = process.env.DATABASE_URL;
  if (url && url.length > 0) {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pg = (await import('pg')).default;
    const pool: PgPool = new pg.Pool({ connectionString: url });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    return {
      db: db as unknown as Db,
      query: async (sql, params) => pool.query(sql, params as unknown[]),
      authoritative: true,
      label: 'AUTHORITATIVE — real Postgres (DATABASE_URL)',
      maxLeads: envInt('PERF_MAX_LEADS', Number.POSITIVE_INFINITY),
      close: async () => {
        await pool.end();
      },
    };
  }

  const client = new PGlite({ extensions: { citext } });
  const db = drizzlePglite(client);
  await migratePglite(db, { migrationsFolder: MIGRATIONS });
  return {
    db: db as unknown as Db,
    query: async (sql, params) => client.query(sql, params as unknown[]),
    authoritative: false,
    label: 'NON-AUTHORITATIVE — PGlite in-process smoke (gate is real-PG only, DECISIONS D-003)',
    maxLeads: envInt('PERF_MAX_LEADS', DEFAULT_PGLITE_LEADS),
    close: async () => {
      await client.close();
    },
  };
}

// --- Fixture presence -------------------------------------------------------

function ensureFixtures(): void {
  if (fixturesPresent(LATENCY_DIR, 'ndjson')) return;
  process.stdout.write(
    '[perf] latency fixtures absent — generating (fixtures:generate:latency)…\n',
  );
  const res = spawnSync('pnpm', ['--filter', '@switchboard/fixtures', 'run', 'generate:latency'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    throw new Error('failed to generate latency fixtures — run `pnpm fixtures:generate:latency`');
  }
  if (!fixturesPresent(LATENCY_DIR, 'ndjson')) {
    throw new Error('latency fixtures still absent after generation');
  }
}

// --- Smart View field catalog (mirrors the fixture custom fields) -----------

const FIELD_CATALOG: readonly DslCustomFieldDef[] = [
  { key: 'industry', entity: 'lead', type: 'select' },
  { key: 'tier', entity: 'lead', type: 'select' },
  { key: 'employees', entity: 'lead', type: 'number' },
  { key: 'is_target', entity: 'lead', type: 'bool' },
];

// --- Anchors resolved from the loaded data ----------------------------------

interface Anchors {
  readonly meUserId: string;
  readonly hotLeadId: string;
  readonly taskAssigneeId: string;
  readonly searchTerm: string;
  readonly statusLabel: string;
  readonly cursorSortValue: string;
  readonly cursorId: string;
  /**
   * Execution "now" anchored to the dataset's newest touch, not wall clock. The
   * fixture is deterministic (dates end at its generation anchor), so relative
   * predicates like `within 30d` would match nothing when run later — anchoring
   * keeps their selectivity realistic and the benchmark stable over time.
   */
  readonly anchorNow: Date;
}

async function firstCell<T>(
  q: RawQuery,
  sql: string,
  params: readonly unknown[],
): Promise<T | null> {
  const { rows } = await q(sql, params);
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  const [value] = Object.values(row);
  return (value ?? null) as T | null;
}

async function resolveAnchors(q: RawQuery): Promise<Anchors> {
  const maxTouch = await firstCell<unknown>(
    q,
    `SELECT max(last_contacted_at) FROM leads WHERE deleted_at IS NULL`,
    [],
  );
  const anchorNow = maxTouch ? new Date(toIso(maxTouch)) : new Date();
  const meUserId = await firstCell<string>(
    q,
    `SELECT owner_id FROM leads WHERE owner_id IS NOT NULL AND deleted_at IS NULL
     GROUP BY owner_id ORDER BY count(*) DESC LIMIT 1`,
    [],
  );
  const hotLeadId = await firstCell<string>(
    q,
    `SELECT lead_id FROM activities GROUP BY lead_id ORDER BY count(*) DESC LIMIT 1`,
    [],
  );
  const taskAssigneeId =
    (await firstCell<string>(
      q,
      `SELECT assignee_id FROM tasks WHERE completed_at IS NULL AND due_at <= $1
       AND assignee_id IS NOT NULL GROUP BY assignee_id ORDER BY count(*) DESC LIMIT 1`,
      [anchorNow.toISOString()],
    )) ??
    (await firstCell<string>(
      q,
      `SELECT assignee_id FROM tasks WHERE assignee_id IS NOT NULL LIMIT 1`,
      [],
    ));
  const searchTerm =
    (await firstCell<string>(
      q,
      `SELECT lower(split_part(name, ' ', 1)) AS w FROM leads
       WHERE length(split_part(name, ' ', 1)) >= 4 AND deleted_at IS NULL LIMIT 1`,
      [],
    )) ?? 'group';
  const statusLabel =
    (await firstCell<string>(q, `SELECT label FROM lead_statuses LIMIT 1`, [])) ?? 'Contacted';

  // Keyset page-2 anchor: the 50th row under the default (created desc) ordering.
  const { rows: cursorRows } = await q(
    `SELECT id, created_at FROM leads WHERE deleted_at IS NULL
     ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET 49`,
    [],
  );
  const cursor = (cursorRows[0] ?? {}) as { id?: string; created_at?: unknown };

  if (!meUserId || !hotLeadId || !taskAssigneeId || !cursor.id) {
    throw new Error('could not resolve perf anchors — is the fixture loaded?');
  }

  return {
    meUserId,
    hotLeadId,
    taskAssigneeId,
    searchTerm,
    statusLabel,
    cursorSortValue: toIso(cursor.created_at),
    cursorId: cursor.id,
    anchorNow,
  };
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// --- Bench registry ---------------------------------------------------------

interface Bench {
  readonly name: string;
  readonly group: 'smart-view' | 'read-path';
  readonly sql: string;
  readonly params: readonly unknown[];
}

function buildBenches(a: Anchors, now: Date): Bench[] {
  const ctx: CompileContext = {
    currentUserId: a.meUserId,
    orgTimezone: 'UTC',
    fieldCatalog: FIELD_CATALOG,
    now,
  };
  const dsl = (
    name: string,
    text: string,
    opts?: { sort?: SortSpec; cursor?: { sortValue: string; id: string } },
  ): Bench => {
    const ast = parse(text, { fieldCatalog: FIELD_CATALOG });
    const compiled: CompiledQuery = compile(ast, ctx, {
      limit: 50,
      ...(opts?.sort ? { sort: opts.sort } : {}),
      ...(opts?.cursor ? { cursor: opts.cursor } : {}),
    });
    return { name, group: 'smart-view', sql: compiled.sql, params: compiled.params };
  };

  const st = JSON.stringify(a.statusLabel).slice(1, -1);

  return [
    dsl('SV status = X and owner in (me)', `status = "${st}" and owner in (me)`),
    dsl(
      'SV last_contacted < 7d ago and owner in (me)',
      `last_contacted < 7d ago and owner in (me)`,
    ),
    dsl(
      'SV has call within 30d and opportunity.value > 5000',
      `has call within 30d and opportunity.value > 5000`,
    ),
    dsl('SV custom.tier = "smb" (select eq)', `custom.tier = "smb"`),
    dsl('SV custom.employees > 1000 (number)', `custom.employees > 1000`),
    dsl(
      'SV no inbound_email within 14d and status = X',
      `no inbound_email within 14d and status = "${st}"`,
    ),
    dsl(
      'SV 3-clause: status and has email 30d and owner(me)',
      `status = "${st}" and has email within 30d and owner in (me)`,
    ),
    // Keyset page-2 through the compiler (cursor = 50th row of page 1).
    dsl('Keyset page-2 (dnc = false, created desc)', `dnc = false`, {
      sort: { field: 'created', direction: 'desc' },
      cursor: { sortValue: a.cursorSortValue, id: a.cursorId },
    }),
    {
      name: 'Timeline: 50 events for hot lead',
      group: 'read-path',
      sql: `SELECT id, type, occurred_at, payload FROM activities
            WHERE lead_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 50`,
      params: [a.hotLeadId],
    },
    {
      name: 'Inbox: open tasks due for user',
      group: 'read-path',
      sql: `SELECT id, lead_id, title, due_at FROM tasks
            WHERE assignee_id = $1 AND completed_at IS NULL AND due_at <= $2
            ORDER BY due_at ASC LIMIT 50`,
      params: [a.taskAssigneeId, now.toISOString()],
    },
    {
      name: 'Search: websearch_to_tsquery over search_tsv',
      group: 'read-path',
      sql: `SELECT id FROM leads
            WHERE deleted_at IS NULL AND search_tsv @@ websearch_to_tsquery('english', $1)
            LIMIT 50`,
      params: [a.searchTerm],
    },
    {
      name: 'Lead detail: status + owner + child counts',
      group: 'read-path',
      sql: `SELECT l.id, l.name, s.label AS status_label, u.name AS owner_name,
              (SELECT count(*) FROM contacts c WHERE c.lead_id = l.id AND c.deleted_at IS NULL) AS contacts,
              (SELECT count(*) FROM opportunities o WHERE o.lead_id = l.id) AS opportunities
            FROM leads l
            LEFT JOIN lead_statuses s ON s.id = l.status_id
            LEFT JOIN users u ON u.id = l.owner_id
            WHERE l.id = $1`,
      params: [a.hotLeadId],
    },
  ];
}

// --- Timing -----------------------------------------------------------------

interface Timing {
  readonly name: string;
  readonly group: Bench['group'];
  readonly rows: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? 0;
}

async function timeBench(q: RawQuery, b: Bench): Promise<Timing> {
  let rows = 0;
  for (let i = 0; i < WARMUP; i++) {
    const r = await q(b.sql, b.params);
    rows = r.rows.length;
  }
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    const r = await q(b.sql, b.params);
    samples.push(performance.now() - t0);
    rows = r.rows.length;
  }
  samples.sort((x, y) => x - y);
  return {
    name: b.name,
    group: b.group,
    rows,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
  };
}

// --- Reporting --------------------------------------------------------------

function fmt(ms: number): string {
  return ms.toFixed(2);
}

function printTable(timings: readonly Timing[], authoritative: boolean): void {
  const nameW = Math.max(6, ...timings.map((t) => t.name.length));
  const head =
    pad('query', nameW) +
    '  ' +
    padStart('rows', 6) +
    '  ' +
    padStart('p50 ms', 9) +
    '  ' +
    padStart('p95 ms', 9) +
    '  ' +
    padStart('p99 ms', 9) +
    (authoritative ? '   gate' : '');
  process.stdout.write(head + '\n');
  process.stdout.write('-'.repeat(head.length) + '\n');
  for (const t of timings) {
    const over = authoritative && t.p95 > BUDGET_MS;
    const gate = authoritative ? (over ? '   FAIL' : '   ok') : '';
    process.stdout.write(
      pad(t.name, nameW) +
        '  ' +
        padStart(String(t.rows), 6) +
        '  ' +
        padStart(fmt(t.p50), 9) +
        '  ' +
        padStart(fmt(t.p95), 9) +
        '  ' +
        padStart(fmt(t.p99), 9) +
        gate +
        '\n',
    );
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
function padStart(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<number> {
  ensureFixtures();
  const backend = await makeBackend();
  try {
    process.stdout.write(`[perf] backend: ${backend.label}\n`);
    const maxLabel = Number.isFinite(backend.maxLeads) ? String(backend.maxLeads) : 'all (100k)';
    process.stdout.write(`[perf] loading latency fixture (maxLeads=${maxLabel})…\n`);
    const t0 = performance.now();
    const counts = await loadLatencyFixtures(
      backend.db,
      Number.isFinite(backend.maxLeads) ? { maxLeads: backend.maxLeads } : {},
    );
    const loadS = ((performance.now() - t0) / 1000).toFixed(1);
    process.stdout.write(
      `[perf] loaded in ${loadS}s: ${counts.leads} leads · ${counts.contacts} contacts · ` +
        `${counts.opportunities} opps · ${counts.tasks} tasks · ${counts.activities} activities\n`,
    );

    // ANALYZE so the planner has stats (real PG; PGlite is best-effort).
    try {
      await backend.query('ANALYZE', []);
    } catch {
      // PGlite may not support bare ANALYZE in all builds — non-fatal.
    }

    const anchors = await resolveAnchors(backend.query);
    const benches = buildBenches(anchors, anchors.anchorNow);
    process.stdout.write(
      `[perf] timing ${benches.length} reads · ${WARMUP} warmup + ${ITERS} iters each\n\n`,
    );

    const timings: Timing[] = [];
    for (const b of benches) {
      timings.push(await timeBench(backend.query, b));
    }

    printTable(timings, backend.authoritative);

    const worst = timings.reduce((m, t) => Math.max(m, t.p95), 0);
    process.stdout.write(`\n[perf] worst core p95 = ${fmt(worst)} ms (budget ${BUDGET_MS} ms)\n`);

    if (!backend.authoritative) {
      process.stdout.write(
        '[perf] NON-AUTHORITATIVE run (PGlite) — timings are a smoke check only, gate not enforced.\n',
      );
      return 0;
    }
    const breaches = timings.filter((t) => t.p95 > BUDGET_MS);
    if (breaches.length > 0) {
      process.stdout.write(
        `[perf] GATE FAILED — ${breaches.length} read(s) over budget: ${breaches
          .map((b) => b.name)
          .join(', ')}\n`,
      );
      return 1;
    }
    process.stdout.write('[perf] GATE PASSED — all core p95 within budget.\n');
    return 0;
  } finally {
    await backend.close();
  }
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(
      `[perf] ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(2);
  },
);
