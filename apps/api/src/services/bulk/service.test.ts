import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse } from '@switchboard/shared';

import {
  activities,
  contacts,
  leadStatuses,
  leads,
  sequenceEnrollments,
  smartViews,
  users,
  type Db,
} from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { seedSequence } from '../sequences/test-helpers.ts';
import type { QueueDriver } from '../../queue/index.ts';
import type { RawQueryable } from '../smartviews/index.ts';
import {
  BulkInputError,
  BulkService,
  BulkTargetError,
  type EnrollSummary,
  type ExportSummary,
  type MutationSummary,
} from './index.ts';

/**
 * Task R3 — bulk-action engine on PGlite (D-003). The load-bearing acceptance:
 * every action mutates the record set AND emits the right C4 event, and the
 * compliance rails hold — a DNC lead/contact is NEVER enrolled (I-DNC), and a DNC
 * set/clear without an audit reason is rejected. Plus target resolution via a
 * stored smart view and via an inline ast, and the C8 failure paths.
 */

const ORG_TZ = 'UTC';
const CLOCK = new Date('2026-03-02T15:00:00.000Z');

const NOOP_QUEUE: QueueDriver = {
  enqueue: async () => {},
  process: () => {},
  close: async () => {},
};

const ST_A = '22222222-0000-4000-8000-0000000000a1';
const ST_B = '22222222-0000-4000-8000-0000000000b2';

let ctx: TestDb;
let db: Db;
let service: BulkService;
let seq = 0;

async function seedUser(): Promise<string> {
  const id = randomUUID();
  const email = `rep${(seq += 1)}@t.test`;
  await db
    .insert(users)
    .values({ id, email, name: 'Rep', role: 'rep', idpSubject: `idp|${email}` });
  return id;
}

async function seedLead(
  ownerId: string,
  opts: { dnc?: boolean; statusId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(leads).values({
    id,
    name: `Lead ${id.slice(0, 8)}`,
    ownerId,
    ...(opts.statusId !== undefined ? { statusId: opts.statusId } : {}),
    ...(opts.dnc === true ? { dnc: true } : {}),
  });
  return id;
}

async function seedContact(leadId: string, opts: { dnc?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await db.insert(contacts).values({
    id,
    leadId,
    name: 'Contact',
    emails: [{ email: `c${id.slice(0, 6)}@t.test`, type: 'work' }],
    ...(opts.dnc === true ? { dnc: true } : {}),
  });
  return id;
}

/** A shared smart view over `owner in (me)` — resolves to the actor's leads. */
async function seedOwnerView(): Promise<string> {
  const id = randomUUID();
  const dsl = 'owner in (me)';
  await db.insert(smartViews).values({
    id,
    name: dsl,
    ownerId: null,
    shared: true,
    dsl,
    ast: parse(dsl, { fieldCatalog: [] }) as unknown as Record<string, unknown>,
  });
  return id;
}

async function activityCount(leadIds: string[], type: string): Promise<number> {
  if (leadIds.length === 0) return 0;
  const rows = await db
    .select({ n: count() })
    .from(activities)
    .where(and(inArray(activities.leadId, leadIds), sql`${activities.type} = ${type}`));
  return Number(rows[0]?.n ?? 0);
}

async function enrollmentCount(leadId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.leadId, leadId));
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);
  db = ctx.db;
  await db.insert(leadStatuses).values([
    { id: ST_A, label: 'Potential', sortOrder: 0 },
    { id: ST_B, label: 'Qualified', sortOrder: 1 },
  ]);
  service = new BulkService({
    db,
    client: ctx.client as unknown as RawQueryable,
    orgTimezone: ORG_TZ,
    queue: NOOP_QUEUE,
    now: () => CLOCK,
  });
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

describe('bulk — assign owner', () => {
  test('reassigns every target and emits one field_changed per lead', async () => {
    const me = await seedUser();
    const newOwner = await seedUser();
    const a = await seedLead(me);
    const b = await seedLead(me);
    const viewId = await seedOwnerView();

    const result = await service.run(
      { smartViewId: viewId, action: 'assign', params: { ownerId: newOwner } },
      { userId: me },
    );
    expect(result.targetCount).toBe(2);
    const summary = result.summary as MutationSummary;
    expect(summary.updated).toBe(2);

    const owners = await db
      .select({ ownerId: leads.ownerId })
      .from(leads)
      .where(inArray(leads.id, [a, b]));
    expect(owners.every((o) => o.ownerId === newOwner)).toBe(true);
    expect(await activityCount([a, b], 'field_changed')).toBe(2);
  });

  test('assign without ownerId → BulkInputError', async () => {
    const me = await seedUser();
    await seedLead(me);
    const viewId = await seedOwnerView();
    await expect(
      service.run({ smartViewId: viewId, action: 'assign', params: {} }, { userId: me }),
    ).rejects.toBeInstanceOf(BulkInputError);
  });

  test('assign to a non-existent user → BulkInputError', async () => {
    const me = await seedUser();
    await seedLead(me);
    const viewId = await seedOwnerView();
    await expect(
      service.run(
        { smartViewId: viewId, action: 'assign', params: { ownerId: randomUUID() } },
        { userId: me },
      ),
    ).rejects.toBeInstanceOf(BulkInputError);
  });
});

describe('bulk — set status', () => {
  test('updates status_id and emits status_changed', async () => {
    const me = await seedUser();
    const a = await seedLead(me, { statusId: ST_A });
    const viewId = await seedOwnerView();

    const result = await service.run(
      { smartViewId: viewId, action: 'set-status', params: { statusId: ST_B } },
      { userId: me },
    );
    expect((result.summary as MutationSummary).updated).toBe(1);
    const row = await db.select({ statusId: leads.statusId }).from(leads).where(eq(leads.id, a));
    expect(row[0]?.statusId).toBe(ST_B);
    expect(await activityCount([a], 'status_changed')).toBe(1);
  });
});

describe('bulk — DNC set/clear (rail: reason required)', () => {
  test('set-dnc flips the flag and emits dnc_set', async () => {
    const me = await seedUser();
    const a = await seedLead(me);
    const viewId = await seedOwnerView();

    const result = await service.run(
      { smartViewId: viewId, action: 'set-dnc', params: { reason: 'Requested by contact' } },
      { userId: me },
    );
    expect((result.summary as MutationSummary).updated).toBe(1);
    const row = await db.select({ dnc: leads.dnc }).from(leads).where(eq(leads.id, a));
    expect(row[0]?.dnc).toBe(true);
    expect(await activityCount([a], 'dnc_set')).toBe(1);
  });

  test('clear-dnc flips it back and emits dnc_cleared', async () => {
    const me = await seedUser();
    const a = await seedLead(me, { dnc: true });
    const viewId = await seedOwnerView();

    const result = await service.run(
      { smartViewId: viewId, action: 'clear-dnc', params: { reason: 'Re-opted in' } },
      { userId: me },
    );
    expect((result.summary as MutationSummary).updated).toBe(1);
    const row = await db.select({ dnc: leads.dnc }).from(leads).where(eq(leads.id, a));
    expect(row[0]?.dnc).toBe(false);
    expect(await activityCount([a], 'dnc_cleared')).toBe(1);
  });

  test('set-dnc without a reason → BulkInputError (nothing written)', async () => {
    const me = await seedUser();
    const a = await seedLead(me);
    const viewId = await seedOwnerView();
    await expect(
      service.run({ smartViewId: viewId, action: 'set-dnc', params: {} }, { userId: me }),
    ).rejects.toBeInstanceOf(BulkInputError);
    const row = await db.select({ dnc: leads.dnc }).from(leads).where(eq(leads.id, a));
    expect(row[0]?.dnc).toBe(false);
    expect(await activityCount([a], 'dnc_set')).toBe(0);
  });

  test('already-DNC leads are skipped, not double-emitted', async () => {
    const me = await seedUser();
    const a = await seedLead(me, { dnc: true });
    const viewId = await seedOwnerView();
    const result = await service.run(
      { smartViewId: viewId, action: 'set-dnc', params: { reason: 'x' } },
      { userId: me },
    );
    const summary = result.summary as MutationSummary;
    expect(summary.updated).toBe(0);
    expect(summary.skipReasons['already_dnc']).toBe(1);
    expect(await activityCount([a], 'dnc_set')).toBe(0);
  });
});

describe('bulk — enroll (rail: DNC is never enrolled, I-DNC)', () => {
  test('enrolls non-DNC targets and skips DNC lead / DNC contact / no-contact', async () => {
    const me = await seedUser();
    const { sequenceId } = await seedSequence(db, [{ type: 'call_task', delayHours: 0 }], {
      name: `Seq ${randomUUID().slice(0, 6)}`,
    });

    const clean = await seedLead(me);
    await seedContact(clean);
    const dncLead = await seedLead(me, { dnc: true });
    await seedContact(dncLead);
    const dncContactLead = await seedLead(me);
    await seedContact(dncContactLead, { dnc: true });
    await seedLead(me); // a lead with no contact — skipped as no_contact

    const viewId = await seedOwnerView();
    const result = await service.run(
      { smartViewId: viewId, action: 'enroll', params: { sequenceId } },
      { userId: me },
    );

    const summary = result.summary as EnrollSummary;
    expect(summary.enrolled).toBe(1);
    expect(summary.skipReasons['dnc']).toBe(2);
    expect(summary.skipReasons['no_contact']).toBe(1);

    // The rail, at the row level: only the clean lead has an enrollment.
    expect(await enrollmentCount(clean)).toBe(1);
    expect(await enrollmentCount(dncLead)).toBe(0);
    expect(await enrollmentCount(dncContactLead)).toBe(0);
    expect(await activityCount([clean], 'sequence_enrolled')).toBe(1);
    expect(await activityCount([dncLead, dncContactLead], 'sequence_enrolled')).toBe(0);
  });

  test('enroll without a sequenceId → BulkInputError', async () => {
    const me = await seedUser();
    await seedLead(me);
    const viewId = await seedOwnerView();
    await expect(
      service.run({ smartViewId: viewId, action: 'enroll', params: {} }, { userId: me }),
    ).rejects.toBeInstanceOf(BulkInputError);
  });
});

describe('bulk — export', () => {
  test('csv export contains a header + one row per target lead', async () => {
    const me = await seedUser();
    const a = await seedLead(me);
    const b = await seedLead(me);
    const viewId = await seedOwnerView();
    const result = await service.run(
      { smartViewId: viewId, action: 'export', params: { format: 'csv' } },
      { userId: me },
    );
    const summary = result.summary as ExportSummary;
    expect(summary.format).toBe('csv');
    expect(summary.count).toBe(2);
    const lines = summary.content.split('\r\n');
    expect(lines[0]).toContain('id,name');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(summary.content).toContain(a);
    expect(summary.content).toContain(b);
  });

  test('json export returns a parseable array of the target leads', async () => {
    const me = await seedUser();
    await seedLead(me);
    const viewId = await seedOwnerView();
    const result = await service.run(
      { smartViewId: viewId, action: 'export', params: { format: 'json' } },
      { userId: me },
    );
    const summary = result.summary as ExportSummary;
    expect(summary.format).toBe('json');
    const parsed = JSON.parse(summary.content) as unknown[];
    expect(parsed).toHaveLength(1);
  });
});

describe('bulk — target resolution + failure paths', () => {
  test('resolves an inline ast identically to a stored smart view', async () => {
    const me = await seedUser();
    await seedLead(me);
    await seedLead(me);
    const viewId = await seedOwnerView();

    const viaView = await service.run({ smartViewId: viewId, action: 'export' }, { userId: me });
    const viaAst = await service.run(
      { ast: parse('owner in (me)', { fieldCatalog: [] }) as unknown, action: 'export' },
      { userId: me },
    );
    expect(viaAst.targetCount).toBe(viaView.targetCount);
    expect(viaAst.targetCount).toBe(2);
  });

  test('unknown action → BulkInputError', async () => {
    const me = await seedUser();
    const viewId = await seedOwnerView();
    await expect(
      service.run({ smartViewId: viewId, action: 'nuke' as never, params: {} }, { userId: me }),
    ).rejects.toBeInstanceOf(BulkInputError);
  });

  test('neither smartViewId nor ast → BulkInputError', async () => {
    const me = await seedUser();
    await expect(service.run({ action: 'export' }, { userId: me })).rejects.toBeInstanceOf(
      BulkInputError,
    );
  });

  test('unknown smartViewId → BulkTargetError', async () => {
    const me = await seedUser();
    await expect(
      service.run({ smartViewId: randomUUID(), action: 'export' }, { userId: me }),
    ).rejects.toBeInstanceOf(BulkTargetError);
  });
});
