import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InferInsertModel } from 'drizzle-orm';
import { activityTypeSchema } from '@switchboard/shared';
import {
  activities,
  contacts,
  leads,
  leadStatuses,
  opportunities,
  opportunityStages,
  tasks,
  users,
  type Db,
} from '../../db/index.ts';

/**
 * Fixture loader (Task 1a). Bulk-loads the golden (5k JSON) and latency (100k
 * streamed ndjson) datasets produced by `fixtures/src` into a given Drizzle db
 * (PGlite in tests, real Postgres for the latency gate). Loads are efficient:
 * batched multi-row inserts; the latency path streams ndjson line-by-line so
 * memory stays bounded at 100k+ leads / 1M+ activities.
 *
 * Fixture → schema gap (reported as friction): fixture leads carry `status` and
 * `ownerId` by *value*, and opportunities carry `stage` by *value*, but the C1
 * schema keys them via `status_id`/`owner_id`/`stage_id` FKs. `fixtures/src` is
 * read-only, so the loader synthesizes the missing dimension rows (users,
 * lead_statuses, opportunity_stages) deterministically-per-load and resolves the
 * references — a "sensible default" for defaultable columns, not a generator
 * change.
 */

// --- Fixture shapes (mirrors fixtures/src/types.ts; kept local to decouple) --

interface FixtureLead {
  id: string;
  name: string;
  url: string;
  description: string;
  status: string;
  ownerId: string;
  custom: Record<string, unknown>;
  dnc: boolean;
  lastContactedAt: string | null;
  lastInboundAt: string | null;
  nextTaskDueAt: string | null;
  lastCallAt: string | null;
  lastEmailAt: string | null;
  lastSmsAt: string | null;
  createdAt: string;
}

interface FixtureContact {
  id: string;
  leadId: string;
  name: string;
  title: string;
  emails: { email: string; type: string }[];
  phones: { phone: string; type: string }[];
  dnc: boolean;
}

interface FixtureOpportunity {
  id: string;
  leadId: string;
  contactId: string | null;
  valueCents: number;
  currency: string;
  stage: string;
  confidence: number;
  closeDate: string | null;
  ownerId: string;
  status: 'active' | 'won' | 'lost';
  note: string;
}

interface FixtureTask {
  id: string;
  leadId: string;
  assigneeId: string;
  title: string;
  dueAt: string;
  completedAt: string | null;
}

interface FixtureActivity {
  id: string;
  leadId: string;
  contactId: string | null;
  userId: string | null;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface LoadedCounts {
  leads: number;
  contacts: number;
  opportunities: number;
  tasks: number;
  activities: number;
}

export interface LoadOptions {
  /** Override the fixtures directory (defaults to fixtures/out/{golden|latency}). */
  dir?: string;
  /** Rows per multi-row insert. */
  batchSize?: number;
}

export interface LatencyLoadOptions extends LoadOptions {
  /** Test bound: load only the first N lead bundles (relies on bundle-ordered files). */
  maxLeads?: number;
}

const DEFAULT_BATCH = 1000;

const OUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..', 'fixtures/out');

// Canonical dimension ordering (fixtures use these labels; unknown → appended).
const STATUS_ORDER = ['Potential', 'Contacted', 'Qualified', 'Won', 'Lost'];
const STAGE_ORDER = ['Discovery', 'Proposal', 'Negotiation', 'Closed'];

// --- Dimension resolver (synthesizes users / statuses / stages) -------------

/**
 * Resolves the value-keyed fixture references (owner, status label, stage label)
 * to real dimension rows, inserting each the first time it is seen so FKs hold
 * when the referencing fact row is flushed.
 */
class DimensionResolver {
  private readonly db: Db;
  private readonly userIds = new Set<string>();
  private readonly statusIds = new Map<string, string>();
  private readonly stageIds = new Map<string, string>();

  constructor(db: Db) {
    this.db = db;
  }

  async ensureUser(ownerId: string): Promise<string> {
    if (!this.userIds.has(ownerId)) {
      const short = ownerId.slice(0, 8);
      await this.db
        .insert(users)
        .values({
          id: ownerId,
          email: `owner-${short}@fixtures.switchboard.local`,
          name: `Fixture Owner ${short}`,
          role: 'rep',
          idpSubject: `fixture|${ownerId}`,
          isActive: true,
          timezone: 'UTC',
        })
        .onConflictDoNothing();
      this.userIds.add(ownerId);
    }
    return ownerId;
  }

  async ensureStatus(label: string): Promise<string> {
    const existing = this.statusIds.get(label);
    if (existing) return existing;
    const id = randomUUID();
    const canonical = STATUS_ORDER.indexOf(label);
    await this.db
      .insert(leadStatuses)
      .values({
        id,
        label,
        sortOrder: canonical >= 0 ? canonical : STATUS_ORDER.length + this.statusIds.size,
      })
      .onConflictDoNothing();
    this.statusIds.set(label, id);
    return id;
  }

  async ensureStage(label: string): Promise<string> {
    const existing = this.stageIds.get(label);
    if (existing) return existing;
    const id = randomUUID();
    const canonical = STAGE_ORDER.indexOf(label);
    await this.db
      .insert(opportunityStages)
      .values({
        id,
        label,
        sortOrder: canonical >= 0 ? canonical : STAGE_ORDER.length + this.stageIds.size,
      })
      .onConflictDoNothing();
    this.stageIds.set(label, id);
    return id;
  }
}

// --- Row mappers ------------------------------------------------------------

function mapLead(f: FixtureLead, ownerId: string, statusId: string): InferInsertModel<typeof leads> {
  return {
    id: f.id,
    name: f.name,
    url: f.url,
    description: f.description,
    statusId,
    ownerId,
    custom: f.custom,
    dnc: f.dnc,
    lastContactedAt: f.lastContactedAt,
    lastInboundAt: f.lastInboundAt,
    nextTaskDueAt: f.nextTaskDueAt,
    lastCallAt: f.lastCallAt,
    lastEmailAt: f.lastEmailAt,
    lastSmsAt: f.lastSmsAt,
    createdAt: f.createdAt,
  };
}

function mapContact(f: FixtureContact): InferInsertModel<typeof contacts> {
  return {
    id: f.id,
    leadId: f.leadId,
    name: f.name,
    title: f.title,
    emails: f.emails,
    phones: f.phones,
    dnc: f.dnc,
  };
}

function mapOpportunity(
  f: FixtureOpportunity,
  ownerId: string,
  stageId: string,
): InferInsertModel<typeof opportunities> {
  return {
    id: f.id,
    leadId: f.leadId,
    contactId: f.contactId,
    valueCents: f.valueCents,
    currency: f.currency,
    stageId,
    confidence: f.confidence,
    closeDate: f.closeDate,
    ownerId,
    status: f.status,
    note: f.note,
  };
}

function mapTask(f: FixtureTask): InferInsertModel<typeof tasks> {
  return {
    id: f.id,
    leadId: f.leadId,
    assigneeId: f.assigneeId,
    title: f.title,
    dueAt: f.dueAt,
    completedAt: f.completedAt,
    createdBy: f.assigneeId,
  };
}

function mapActivity(f: FixtureActivity): InferInsertModel<typeof activities> {
  return {
    id: f.id,
    leadId: f.leadId,
    contactId: f.contactId,
    userId: f.userId,
    type: activityTypeSchema.parse(f.type),
    occurredAt: f.occurredAt,
    payload: f.payload,
  };
}

// --- Batched insert ---------------------------------------------------------

/** Accumulates rows and flushes them in multi-row inserts of `batchSize`. */
class Batcher<TRow extends Record<string, unknown>> {
  private readonly db: Db;
  private readonly table: Parameters<Db['insert']>[0];
  private readonly batchSize: number;
  private buffer: TRow[] = [];
  count = 0;

  constructor(db: Db, table: Parameters<Db['insert']>[0], batchSize: number) {
    this.db = db;
    this.table = table;
    this.batchSize = batchSize;
  }

  async add(row: TRow): Promise<void> {
    this.buffer.push(row);
    this.count += 1;
    if (this.buffer.length >= this.batchSize) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    await this.db.insert(this.table).values(rows);
  }
}

// --- Golden (in-memory JSON) ------------------------------------------------

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/**
 * Load the golden dataset (5k leads) from JSON. Runs in a single transaction:
 * fast and atomic (all-or-nothing).
 */
export async function loadGoldenFixtures(db: Db, opts: LoadOptions = {}): Promise<LoadedCounts> {
  const dir = opts.dir ?? resolve(OUT_ROOT, 'golden');
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;

  const [leadRows, contactRows, oppRows, taskRows, activityRows] = await Promise.all([
    readJson<FixtureLead[]>(resolve(dir, 'leads.json')),
    readJson<FixtureContact[]>(resolve(dir, 'contacts.json')),
    readJson<FixtureOpportunity[]>(resolve(dir, 'opportunities.json')),
    readJson<FixtureTask[]>(resolve(dir, 'tasks.json')),
    readJson<FixtureActivity[]>(resolve(dir, 'activities.json')),
  ]);

  return db.transaction(async (tx) => {
    const dims = new DimensionResolver(tx);

    const leadBatch = new Batcher<InferInsertModel<typeof leads>>(tx, leads, batchSize);
    for (const f of leadRows) {
      const ownerId = await dims.ensureUser(f.ownerId);
      const statusId = await dims.ensureStatus(f.status);
      await leadBatch.add(mapLead(f, ownerId, statusId));
    }
    await leadBatch.flush();

    const contactBatch = new Batcher<InferInsertModel<typeof contacts>>(tx, contacts, batchSize);
    for (const f of contactRows) await contactBatch.add(mapContact(f));
    await contactBatch.flush();

    const oppBatch = new Batcher<InferInsertModel<typeof opportunities>>(
      tx,
      opportunities,
      batchSize,
    );
    for (const f of oppRows) {
      const ownerId = await dims.ensureUser(f.ownerId);
      const stageId = await dims.ensureStage(f.stage);
      await oppBatch.add(mapOpportunity(f, ownerId, stageId));
    }
    await oppBatch.flush();

    const taskBatch = new Batcher<InferInsertModel<typeof tasks>>(tx, tasks, batchSize);
    for (const f of taskRows) {
      await dims.ensureUser(f.assigneeId);
      await taskBatch.add(mapTask(f));
    }
    await taskBatch.flush();

    const activityBatch = new Batcher<InferInsertModel<typeof activities>>(
      tx,
      activities,
      batchSize,
    );
    for (const f of activityRows) await activityBatch.add(mapActivity(f));
    await activityBatch.flush();

    return {
      leads: leadBatch.count,
      contacts: contactBatch.count,
      opportunities: oppBatch.count,
      tasks: taskBatch.count,
      activities: activityBatch.count,
    };
  });
}

// --- Latency (streamed ndjson) ----------------------------------------------

/** Async-iterate the JSON records of an ndjson file, memory-bounded. */
async function* streamNdjson<T>(path: string): AsyncGenerator<T> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      yield JSON.parse(line) as T;
    }
  } finally {
    rl.close();
  }
}

/**
 * Load the latency dataset (100k leads) by streaming ndjson. Not wrapped in one
 * giant transaction — batches autocommit so memory and lock footprint stay flat
 * at scale (this is the perf-gate loader). `maxLeads` bounds a smoke run;
 * because the generator writes child files in bundle order, child streams stop
 * at the first record outside the loaded lead set.
 */
export async function loadLatencyFixtures(
  db: Db,
  opts: LatencyLoadOptions = {},
): Promise<LoadedCounts> {
  const dir = opts.dir ?? resolve(OUT_ROOT, 'latency');
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const maxLeads = opts.maxLeads ?? Infinity;

  const dims = new DimensionResolver(db);
  const loadedLeadIds = new Set<string>();

  // Leads (+ owner/status dimensions).
  const leadBatch = new Batcher<InferInsertModel<typeof leads>>(db, leads, batchSize);
  for await (const f of streamNdjson<FixtureLead>(resolve(dir, 'leads.ndjson'))) {
    if (leadBatch.count >= maxLeads) break;
    const ownerId = await dims.ensureUser(f.ownerId);
    const statusId = await dims.ensureStatus(f.status);
    await leadBatch.add(mapLead(f, ownerId, statusId));
    loadedLeadIds.add(f.id);
  }
  await leadBatch.flush();

  const bounded = maxLeads !== Infinity;
  const inScope = (leadId: string): boolean => !bounded || loadedLeadIds.has(leadId);

  // Contacts.
  const contactBatch = new Batcher<InferInsertModel<typeof contacts>>(db, contacts, batchSize);
  for await (const f of streamNdjson<FixtureContact>(resolve(dir, 'contacts.ndjson'))) {
    if (!inScope(f.leadId)) break;
    await contactBatch.add(mapContact(f));
  }
  await contactBatch.flush();

  // Opportunities (+ stage dimension).
  const oppBatch = new Batcher<InferInsertModel<typeof opportunities>>(db, opportunities, batchSize);
  for await (const f of streamNdjson<FixtureOpportunity>(resolve(dir, 'opportunities.ndjson'))) {
    if (!inScope(f.leadId)) break;
    const ownerId = await dims.ensureUser(f.ownerId);
    const stageId = await dims.ensureStage(f.stage);
    await oppBatch.add(mapOpportunity(f, ownerId, stageId));
  }
  await oppBatch.flush();

  // Tasks.
  const taskBatch = new Batcher<InferInsertModel<typeof tasks>>(db, tasks, batchSize);
  for await (const f of streamNdjson<FixtureTask>(resolve(dir, 'tasks.ndjson'))) {
    if (!inScope(f.leadId)) break;
    await dims.ensureUser(f.assigneeId);
    await taskBatch.add(mapTask(f));
  }
  await taskBatch.flush();

  // Activities.
  const activityBatch = new Batcher<InferInsertModel<typeof activities>>(db, activities, batchSize);
  for await (const f of streamNdjson<FixtureActivity>(resolve(dir, 'activities.ndjson'))) {
    if (!inScope(f.leadId)) break;
    await activityBatch.add(mapActivity(f));
  }
  await activityBatch.flush();

  return {
    leads: leadBatch.count,
    contacts: contactBatch.count,
    opportunities: oppBatch.count,
    tasks: taskBatch.count,
    activities: activityBatch.count,
  };
}

/** True if the given fixtures directory looks populated (has the leads file). */
export function fixturesPresent(dir: string, format: 'json' | 'ndjson'): boolean {
  return existsSync(resolve(dir, format === 'json' ? 'leads.json' : 'leads.ndjson'));
}
