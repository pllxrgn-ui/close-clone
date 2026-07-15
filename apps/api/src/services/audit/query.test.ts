import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { auditLog, users, type Db } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { AuditQueryService, InvalidAuditCursorError, type AuditPage } from './query.ts';
import { REDACTED } from './redaction.ts';

/**
 * Task 5b — AuditQueryService: filters, newest-first keyset pagination, and
 * read-time redaction (rows are inserted RAW here — bypassing the writer — to
 * prove the endpoint redacts token material "even if present" in a stored row).
 */

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const REP = '00000000-0000-4000-8000-0000000000a2';

// Distinct, increasing event times → a total (at DESC, id DESC) order.
const T1 = '2026-03-01T00:00:00.000Z';
const T2 = '2026-03-02T00:00:00.000Z';
const T3 = '2026-03-03T00:00:00.000Z';
const T4 = '2026-03-04T00:00:00.000Z';
const T5 = '2026-03-05T00:00:00.000Z';

let ctx: TestDb;
let service: AuditQueryService;
const idByTag = new Map<string, string>();

async function insertAudit(
  db: Db,
  tag: string,
  values: typeof auditLog.$inferInsert,
): Promise<void> {
  const [row] = await db.insert(auditLog).values(values).returning({ id: auditLog.id });
  if (!row) throw new Error(`insert ${tag} failed`);
  idByTag.set(tag, row.id);
}

beforeAll(async () => {
  ctx = await createTestDb();
  service = new AuditQueryService(ctx.db);

  await ctx.db.insert(users).values([
    { id: ADMIN, email: 'admin@x.test', name: 'Admin', role: 'admin', idpSubject: 'idp|admin' },
    { id: REP, email: 'rep@x.test', name: 'Rep', role: 'rep', idpSubject: 'idp|rep' },
  ]);

  await insertAudit(ctx.db, 'r1', {
    action: 'auth.login',
    entity: 'auth',
    actorType: 'user',
    actorId: ADMIN,
    at: T1,
  });
  await insertAudit(ctx.db, 'r2', {
    action: 'admin.user_changed',
    entity: 'user',
    entityId: REP,
    actorType: 'user',
    actorId: ADMIN,
    at: T2,
  });
  await insertAudit(ctx.db, 'r3', {
    action: 'export.started',
    entity: 'export',
    actorType: 'user',
    actorId: REP,
    at: T3,
  });
  await insertAudit(ctx.db, 'r4', {
    action: 'import.committed',
    entity: 'import',
    actorType: 'system',
    actorId: null,
    at: T4,
  });
  await insertAudit(ctx.db, 'r5', {
    action: 'admin.compliance_switch_changed',
    entity: 'email_account',
    actorType: 'user',
    actorId: ADMIN,
    at: T5,
    // Raw token material — must be redacted on read.
    before: { address: 'box@x.test', oauthTokens: 'ya29.OLD' },
    after: { address: 'box@x.test', oauthTokens: 'ya29.NEW' },
  });
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

describe('ordering', () => {
  test('returns rows newest-first', async () => {
    const page = await service.list();
    expect(page.items.map((i) => i.id)).toEqual([
      idByTag.get('r5'),
      idByTag.get('r4'),
      idByTag.get('r3'),
      idByTag.get('r2'),
      idByTag.get('r1'),
    ]);
  });
});

describe('filters', () => {
  test('by action', async () => {
    const page = await service.list({ action: 'auth.login' });
    expect(page.items.map((i) => i.id)).toEqual([idByTag.get('r1')]);
  });

  test('by entity', async () => {
    const page = await service.list({ entity: 'export' });
    expect(page.items.map((i) => i.id)).toEqual([idByTag.get('r3')]);
  });

  test('by actorId', async () => {
    const page = await service.list({ actorId: ADMIN });
    expect(page.items.map((i) => i.id)).toEqual([
      idByTag.get('r5'),
      idByTag.get('r2'),
      idByTag.get('r1'),
    ]);
  });

  test('by actorType system', async () => {
    const page = await service.list({ actorType: 'system' });
    expect(page.items.map((i) => i.id)).toEqual([idByTag.get('r4')]);
  });

  test('by entityId', async () => {
    const page = await service.list({ entityId: REP });
    expect(page.items.map((i) => i.id)).toEqual([idByTag.get('r2')]);
  });

  test('by time range [from, to)', async () => {
    // from = T2 (inclusive), to = T4 (exclusive) → r2, r3 only.
    const page = await service.list({ from: T2, to: T4 });
    expect(page.items.map((i) => i.id)).toEqual([idByTag.get('r3'), idByTag.get('r2')]);
  });

  test('combined filters (actorId + action) narrow further', async () => {
    const page = await service.list({ actorId: ADMIN, action: 'admin.user_changed' });
    expect(page.items.map((i) => i.id)).toEqual([idByTag.get('r2')]);
  });

  test('no matches yields an empty page with no cursor', async () => {
    const page = await service.list({ action: 'lead.merged' });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('read-time redaction', () => {
  test('token material stored in a row is redacted in the response', async () => {
    const page = await service.list({ entity: 'email_account' });
    const item = page.items[0];
    expect(item).toBeDefined();
    expect(item!.before).toEqual({ address: 'box@x.test', oauthTokens: REDACTED });
    expect(item!.after).toEqual({ address: 'box@x.test', oauthTokens: REDACTED });
  });
});

describe('keyset pagination', () => {
  test('walks every row once, in order, across pages', async () => {
    const expected = ['r5', 'r4', 'r3', 'r2', 'r1'].map((t) => idByTag.get(t));
    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page: AuditPage = await service.list({
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const i of page.items) seen.push(i.id);
      cursor = page.nextCursor;
      guard += 1;
      expect(guard).toBeLessThan(20);
    } while (cursor !== undefined);

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('the last page omits nextCursor', async () => {
    const page = await service.list({ limit: 100 });
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('cursor failure paths', () => {
  test('a malformed cursor throws InvalidAuditCursorError', async () => {
    await expect(service.list({ cursor: 'not-valid-base64-json!!' })).rejects.toBeInstanceOf(
      InvalidAuditCursorError,
    );
  });

  test('a cursor with a non-uuid id throws InvalidAuditCursorError', async () => {
    const bad = Buffer.from(JSON.stringify({ at: T1, id: 'nope' }), 'utf8').toString('base64url');
    await expect(service.list({ cursor: bad })).rejects.toBeInstanceOf(InvalidAuditCursorError);
  });

  test('a cursor with a non-date at throws InvalidAuditCursorError', async () => {
    const bad = Buffer.from(JSON.stringify({ at: 'whenever', id: ADMIN }), 'utf8').toString(
      'base64url',
    );
    await expect(service.list({ cursor: bad })).rejects.toBeInstanceOf(InvalidAuditCursorError);
  });
});
