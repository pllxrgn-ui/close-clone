import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { compile, parse, type Ast, type DslCustomFieldDef } from '@switchboard/shared';

import { customFieldDefs, leadStatuses, leads, users, type Db } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { ParseError, SmartViewInputError, SmartViewService } from './index.ts';
import type { RawQueryable } from './support.ts';

/**
 * Task R3 — smart-view CRUD + preview service on PGlite (DECISIONS D-003).
 *
 * The load-bearing acceptance: `preview({dsl})` returns EXACTLY the leads the
 * SINGLE query authority (`@switchboard/shared` compile) selects — asserted by
 * compiling the same DSL independently in the test and comparing id sets — plus a
 * correct count estimate and keyset paging. Also covers CRUD, owner+shared list
 * scoping, `custom.<key>` resolution, and the C8 failure paths.
 */

const ORG_TZ = 'UTC';
const NOW = new Date('2026-06-03T15:30:00.000Z');

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const ST_WON = '22222222-0000-4000-8000-000000000001';
const ST_LOST = '22222222-0000-4000-8000-000000000002';

// Catalog seeded into custom_field_defs AND used as the reference for direct
// compilation. The service loads its catalog from the DB; they must agree.
const CATALOG: DslCustomFieldDef[] = [
  { key: 'tier', entity: 'lead', type: 'select', options: ['gold', 'silver'] },
  { key: 'employees', entity: 'lead', type: 'number', options: null },
];

let ctx: TestDb;
let db: Db;
let client: RawQueryable;
let service: SmartViewService;

/** All "Won" lead ids, in the compiler's default order (created desc, id desc). */
let wonIdsOrdered: string[] = [];

function isoMinus(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

async function seedLead(opts: {
  statusId: string;
  ownerId: string;
  createdAt: string;
  dnc?: boolean;
  tier?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(leads).values({
    id,
    name: `Lead ${opts.createdAt}`,
    statusId: opts.statusId,
    ownerId: opts.ownerId,
    ...(opts.dnc === true ? { dnc: true } : {}),
    custom: opts.tier !== undefined ? { tier: opts.tier } : {},
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  });
  return id;
}

/** Independently compile a DSL and run it — the golden reference for preview. */
async function compileIds(dsl: string, limit: number): Promise<string[]> {
  const ast = parse(dsl, { fieldCatalog: CATALOG });
  const { sql, params } = compile(
    ast,
    { currentUserId: USER_A, orgTimezone: ORG_TZ, fieldCatalog: CATALOG, now: NOW },
    { limit },
  );
  const res = await client.query<{ id: string }>(sql, params);
  return res.rows.map((r) => r.id);
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);
  db = ctx.db;
  client = ctx.client as unknown as RawQueryable;
  service = new SmartViewService({ db, client, orgTimezone: ORG_TZ });

  await db.insert(users).values([
    { id: USER_A, email: 'a@example.com', name: 'Rep A', role: 'rep', idpSubject: 'idp|a' },
    { id: USER_B, email: 'b@example.com', name: 'Rep B', role: 'rep', idpSubject: 'idp|b' },
  ]);
  await db.insert(leadStatuses).values([
    { id: ST_WON, label: 'Won', sortOrder: 0 },
    { id: ST_LOST, label: 'Lost', sortOrder: 1 },
  ]);
  await db.insert(customFieldDefs).values([
    { entity: 'lead', key: 'tier', label: 'Tier', type: 'select', options: ['gold', 'silver'] },
    { entity: 'lead', key: 'employees', label: 'Employees', type: 'number', options: null },
  ]);

  // 25 Won + owner A (8 tagged gold), 5 Lost + owner A, 6 Won + owner B.
  let minute = 0;
  for (let i = 0; i < 25; i += 1) {
    await seedLead({
      statusId: ST_WON,
      ownerId: USER_A,
      createdAt: isoMinus((minute += 1)),
      ...(i < 8 ? { tier: 'gold' } : {}),
    });
  }
  for (let i = 0; i < 5; i += 1) {
    await seedLead({ statusId: ST_LOST, ownerId: USER_A, createdAt: isoMinus((minute += 1)) });
  }
  for (let i = 0; i < 6; i += 1) {
    await seedLead({ statusId: ST_WON, ownerId: USER_B, createdAt: isoMinus((minute += 1)) });
  }

  wonIdsOrdered = await compileIds('status = "Won"', 500);
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

describe('SmartViewService — CRUD', () => {
  test('create parses the dsl, stores owner + ast, and reads back', async () => {
    const created = await service.create(
      { name: 'My open', dsl: 'owner in (me) and status != "Lost"', shared: false },
      USER_A,
    );
    expect(created.name).toBe('My open');
    expect(created.ownerId).toBe(USER_A);
    expect(created.shared).toBe(false);
    // ast round-trips through parse: same shape as parsing the dsl directly.
    expect(created.ast).toEqual(parse(created.dsl, { fieldCatalog: CATALOG }) as unknown);
    const fetched = await service.get(created.id);
    expect(fetched?.id).toBe(created.id);
  });

  test('create rejects invalid dsl with a ParseError', async () => {
    await expect(service.create({ name: 'bad', dsl: 'status =' }, USER_A)).rejects.toBeInstanceOf(
      ParseError,
    );
  });

  test('update patches fields and re-parses a changed dsl; missing id → null', async () => {
    const created = await service.create({ name: 'orig', dsl: 'dnc = true' }, USER_A);
    const updated = await service.update(created.id, { name: 'renamed', dsl: 'dnc = false' });
    expect(updated?.name).toBe('renamed');
    expect(updated?.dsl).toBe('dnc = false');
    expect(updated?.ast).toEqual(parse('dnc = false', { fieldCatalog: CATALOG }) as unknown);
    expect(await service.update(randomUUID(), { name: 'x' })).toBeNull();
  });

  test('update rejects an invalid dsl with ParseError (row unchanged)', async () => {
    const created = await service.create({ name: 'keep', dsl: 'dnc = true' }, USER_A);
    await expect(service.update(created.id, { dsl: 'status =' })).rejects.toBeInstanceOf(
      ParseError,
    );
    expect((await service.get(created.id))?.dsl).toBe('dnc = true');
  });

  test('remove deletes once, then reports not-found', async () => {
    const created = await service.create({ name: 'temp', dsl: 'dnc = true' }, USER_A);
    expect(await service.remove(created.id)).toBe(true);
    expect(await service.remove(created.id)).toBe(false);
    expect(await service.get(created.id)).toBeNull();
  });

  test('list returns shared + own + unowned, hides another user’s private view', async () => {
    const mine = await service.create({ name: 'mine-private', dsl: 'dnc = true' }, USER_A);
    const shared = await service.create({ name: 'team', dsl: 'dnc = true', shared: true }, USER_B);
    const otherPrivate = await service.create({ name: 'theirs', dsl: 'dnc = true' }, USER_B);
    const unowned = await service.create({ name: 'system', dsl: 'dnc = true' }, null);

    const ids = new Set((await service.list(USER_A)).map((v) => v.id));
    expect(ids.has(mine.id)).toBe(true);
    expect(ids.has(shared.id)).toBe(true);
    expect(ids.has(unowned.id)).toBe(true);
    expect(ids.has(otherPrivate.id)).toBe(false);
  });
});

describe('SmartViewService — preview matches the compiler (single query authority)', () => {
  test('first page ids + count match a direct compile of the same dsl', async () => {
    const result = await service.preview({ dsl: 'status = "Won"', limit: 25 }, USER_A, NOW);
    const expected = await compileIds('status = "Won"', 25);
    expect(result.items.map((l) => l.id)).toEqual(expected);
    expect(result.countEstimate).toBe(wonIdsOrdered.length); // 31 Won total
    expect(result.items).toHaveLength(25);
  });

  test('keyset paging is disjoint and reconstructs the full compiled set', async () => {
    const page1 = await service.preview({ dsl: 'status = "Won"', limit: 10 }, USER_A, NOW);
    const cursor = page1.nextCursor;
    expect(cursor).toBeDefined();
    if (cursor === undefined) return;
    expect(page1.items.map((l) => l.id)).toEqual(wonIdsOrdered.slice(0, 10));

    const page2 = await service.preview({ dsl: 'status = "Won"', limit: 10, cursor }, USER_A, NOW);
    expect(page2.items.map((l) => l.id)).toEqual(wonIdsOrdered.slice(10, 20));

    const overlap = page1.items.filter((a) => page2.items.some((b) => b.id === a.id));
    expect(overlap).toEqual([]);
  });

  test('paginating to the end yields no nextCursor and the exact remainder', async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: Awaited<ReturnType<SmartViewService['preview']>> = await service.preview(
        { dsl: 'status = "Won"', limit: 10, ...(cursor !== undefined ? { cursor } : {}) },
        USER_A,
        NOW,
      );
      for (const item of page.items) ids.push(item.id);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(ids).toEqual(wonIdsOrdered);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('accepts an ast body equivalently to a dsl body', async () => {
    const ast: Ast = parse('status = "Won"', { fieldCatalog: CATALOG });
    const viaAst = await service.preview({ ast: ast as unknown, limit: 25 }, USER_A, NOW);
    const viaDsl = await service.preview({ dsl: 'status = "Won"', limit: 25 }, USER_A, NOW);
    expect(viaAst.items.map((l) => l.id)).toEqual(viaDsl.items.map((l) => l.id));
  });

  test('resolves a custom.<key> predicate against the live catalog', async () => {
    const result = await service.preview({ dsl: 'custom.tier = "gold"', limit: 50 }, USER_A, NOW);
    const expected = await compileIds('custom.tier = "gold"', 50);
    expect(result.items.map((l) => l.id).sort()).toEqual([...expected].sort());
    expect(result.countEstimate).toBe(8);
  });

  test('binds `me` to the querying user', async () => {
    const forA = await service.preview({ dsl: 'owner in (me)', limit: 100 }, USER_A, NOW);
    expect(forA.countEstimate).toBe(30); // 25 Won-A + 5 Lost-A
    const forB = await service.preview({ dsl: 'owner in (me)', limit: 100 }, USER_B, NOW);
    expect(forB.countEstimate).toBe(6);
  });
});

describe('SmartViewService — preview failure paths', () => {
  test('neither dsl nor ast → SmartViewInputError', async () => {
    await expect(service.preview({}, USER_A, NOW)).rejects.toBeInstanceOf(SmartViewInputError);
  });

  test('invalid dsl → ParseError', async () => {
    await expect(service.preview({ dsl: 'status =' }, USER_A, NOW)).rejects.toBeInstanceOf(
      ParseError,
    );
  });

  test('invalid ast → SmartViewInputError', async () => {
    await expect(
      service.preview({ ast: { kind: 'nonsense' } }, USER_A, NOW),
    ).rejects.toBeInstanceOf(SmartViewInputError);
  });

  test('malformed cursor → SmartViewInputError', async () => {
    await expect(
      service.preview({ dsl: 'status = "Won"', cursor: '!!!not-base64-json' }, USER_A, NOW),
    ).rejects.toBeInstanceOf(SmartViewInputError);
  });
});
