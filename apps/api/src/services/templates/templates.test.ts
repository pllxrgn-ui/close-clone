import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { seedUser } from '../email/test-helpers.ts';
import {
  InvalidActorError,
  TemplateForbiddenError,
  TemplateNotFoundError,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
} from './index.ts';

/**
 * Templates CRUD (task 2d, CONTRACTS §C1 templates: channel, shared/owner).
 * Visibility: a template is readable by its owner OR when `shared`; it is mutable
 * only by its owner. A private template is invisible (NOT_FOUND, never leaked) to
 * other reps; a shared template is readable but not editable by non-owners
 * (FORBIDDEN). All mutations require a valid, active actor.
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

describe('createTemplate', () => {
  test('creates an owned template', async () => {
    const t = await createTemplate(ctx.db, {
      actorId: owner,
      name: 'Intro',
      channel: 'email',
      subject: 'Hi {{contact.name}}',
      body: 'Body',
    });
    expect(t.id).toBeTruthy();
    expect(t.ownerId).toBe(owner);
    expect(t.channel).toBe('email');
    expect(t.shared).toBe(false);
  });

  test('rejects an unknown actor', async () => {
    await expect(
      createTemplate(ctx.db, {
        actorId: '00000000-0000-4000-8000-0000000000ff',
        name: 'X',
        channel: 'email',
        body: 'b',
      }),
    ).rejects.toBeInstanceOf(InvalidActorError);
  });
});

describe('visibility', () => {
  test('owner reads own private template; other rep gets NOT_FOUND', async () => {
    const t = await createTemplate(ctx.db, { actorId: owner, name: 'Priv', channel: 'email', body: 'b' });
    expect((await getTemplate(ctx.db, t.id, owner)).id).toBe(t.id);
    await expect(getTemplate(ctx.db, t.id, other)).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  test('shared template is readable by a non-owner', async () => {
    const t = await createTemplate(ctx.db, {
      actorId: owner,
      name: 'Shared',
      channel: 'email',
      body: 'b',
      shared: true,
    });
    expect((await getTemplate(ctx.db, t.id, other)).id).toBe(t.id);
  });

  test('list returns own + shared, filtered by channel', async () => {
    await createTemplate(ctx.db, { actorId: owner, name: 'MineEmail', channel: 'email', body: 'b' });
    await createTemplate(ctx.db, { actorId: owner, name: 'MineSms', channel: 'sms', body: 'b' });
    await createTemplate(ctx.db, { actorId: other, name: 'OtherShared', channel: 'email', body: 'b', shared: true });
    await createTemplate(ctx.db, { actorId: other, name: 'OtherPriv', channel: 'email', body: 'b' });

    const emails = await listTemplates(ctx.db, { actorId: owner, channel: 'email' });
    const names = emails.items.map((t) => t.name).sort();
    expect(names).toEqual(['MineEmail', 'OtherShared']);
  });

  test('list paginates via limit + cursor', async () => {
    for (let i = 0; i < 3; i += 1) {
      await createTemplate(ctx.db, { actorId: owner, name: `T${i}`, channel: 'email', body: 'b' });
    }
    const p1 = await listTemplates(ctx.db, { actorId: owner, limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await listTemplates(ctx.db, { actorId: owner, limit: 2, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
  });
});

describe('mutation ownership', () => {
  test('owner updates; non-owner is FORBIDDEN on a shared template', async () => {
    const t = await createTemplate(ctx.db, {
      actorId: owner,
      name: 'S',
      channel: 'email',
      body: 'b',
      shared: true,
    });
    const upd = await updateTemplate(ctx.db, t.id, { actorId: owner, name: 'S2' });
    expect(upd.name).toBe('S2');
    await expect(updateTemplate(ctx.db, t.id, { actorId: other, name: 'hax' })).rejects.toBeInstanceOf(
      TemplateForbiddenError,
    );
  });

  test('non-owner cannot see a private template to update it (NOT_FOUND)', async () => {
    const t = await createTemplate(ctx.db, { actorId: owner, name: 'P', channel: 'email', body: 'b' });
    await expect(updateTemplate(ctx.db, t.id, { actorId: other, name: 'x' })).rejects.toBeInstanceOf(
      TemplateNotFoundError,
    );
  });

  test('owner deletes; then it is gone', async () => {
    const t = await createTemplate(ctx.db, { actorId: owner, name: 'D', channel: 'email', body: 'b' });
    await deleteTemplate(ctx.db, t.id, owner);
    await expect(getTemplate(ctx.db, t.id, owner)).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  test('non-owner cannot delete a shared template (FORBIDDEN)', async () => {
    const t = await createTemplate(ctx.db, {
      actorId: owner,
      name: 'D',
      channel: 'email',
      body: 'b',
      shared: true,
    });
    await expect(deleteTemplate(ctx.db, t.id, other)).rejects.toBeInstanceOf(TemplateForbiddenError);
  });
});
