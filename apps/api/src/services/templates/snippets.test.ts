import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { seedUser } from '../email/test-helpers.ts';
import {
  InvalidActorError,
  SnippetNotFoundError,
  createSnippet,
  deleteSnippet,
  getSnippet,
  listSnippets,
  updateSnippet,
} from './index.ts';

/**
 * Snippets CRUD (task 2d, CONTRACTS §C1 snippets: shortcut, body, owner_id).
 * Snippets are personal (owner-scoped) — a rep sees and edits only their own; a
 * non-owner cannot read or mutate another rep's snippet (NOT_FOUND, never leaked).
 */

let ctx: TestDb;
let owner: string;
let other: string;

beforeEach(async () => {
  ctx = await createTestDb();
  owner = await seedUser(ctx.db, { email: 'owner@example.com' });
  other = await seedUser(ctx.db, { email: 'other@example.com' });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

test('creates and reads an owned snippet', async () => {
  const s = await createSnippet(ctx.db, { actorId: owner, shortcut: ';sig', body: 'Best, Rep' });
  expect(s.shortcut).toBe(';sig');
  expect(s.ownerId).toBe(owner);
  expect((await getSnippet(ctx.db, s.id, owner)).id).toBe(s.id);
});

test('rejects an unknown actor', async () => {
  await expect(
    createSnippet(ctx.db, {
      actorId: '00000000-0000-4000-8000-0000000000ff',
      shortcut: ';x',
      body: 'b',
    }),
  ).rejects.toBeInstanceOf(InvalidActorError);
});

test('list is scoped to the owner', async () => {
  await createSnippet(ctx.db, { actorId: owner, shortcut: ';a', body: 'a' });
  await createSnippet(ctx.db, { actorId: owner, shortcut: ';b', body: 'b' });
  await createSnippet(ctx.db, { actorId: other, shortcut: ';c', body: 'c' });
  const mine = await listSnippets(ctx.db, { actorId: owner });
  expect(mine.items.map((s) => s.shortcut).sort()).toEqual([';a', ';b']);
});

test('a non-owner cannot read, update, or delete', async () => {
  const s = await createSnippet(ctx.db, { actorId: owner, shortcut: ';sig', body: 'x' });
  await expect(getSnippet(ctx.db, s.id, other)).rejects.toBeInstanceOf(SnippetNotFoundError);
  await expect(updateSnippet(ctx.db, s.id, { actorId: other, body: 'hax' })).rejects.toBeInstanceOf(
    SnippetNotFoundError,
  );
  await expect(deleteSnippet(ctx.db, s.id, other)).rejects.toBeInstanceOf(SnippetNotFoundError);
});

test('owner updates and deletes', async () => {
  const s = await createSnippet(ctx.db, { actorId: owner, shortcut: ';sig', body: 'x' });
  const upd = await updateSnippet(ctx.db, s.id, { actorId: owner, body: 'y' });
  expect(upd.body).toBe('y');
  await deleteSnippet(ctx.db, s.id, owner);
  await expect(getSnippet(ctx.db, s.id, owner)).rejects.toBeInstanceOf(SnippetNotFoundError);
});
