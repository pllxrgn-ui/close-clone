import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { snippets, type Db } from '../../db/index.ts';
import {
  assertActiveUser,
  clampLimit,
  decodeCursor,
  encodeCursor,
} from './access.ts';

/**
 * Snippets CRUD (task 2d, CONTRACTS §C1 snippets: `shortcut`, `body`, `owner_id`).
 *
 * Snippets are PERSONAL — there is no `shared` column (unlike templates). A rep
 * sees and mutates only their own; another rep's snippet is invisible
 * (`SnippetNotFoundError`, never leaked). Every mutation requires a valid active
 * actor. Snippet expansion (`;shortcut` → body) is a composer-side convenience;
 * this service is CRUD only.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type SnippetRow = typeof snippets.$inferSelect;

export class SnippetNotFoundError extends Error {
  readonly snippetId: string;
  constructor(snippetId: string) {
    super(`snippet ${snippetId} not found`);
    this.name = 'SnippetNotFoundError';
    this.snippetId = snippetId;
  }
}

export interface CreateSnippetInput {
  actorId: string;
  shortcut: string;
  body: string;
}

export async function createSnippet(db: Db, input: CreateSnippetInput): Promise<SnippetRow> {
  await assertActiveUser(db, input.actorId);
  const rows = await db
    .insert(snippets)
    .values({ shortcut: input.shortcut, body: input.body, ownerId: input.actorId })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('createSnippet: insert returned no row');
  return row;
}

/** Load a snippet the actor OWNS, else NOT_FOUND (personal — never leaked). */
export async function getSnippet(db: Db, id: string, actorId: string): Promise<SnippetRow> {
  const rows = await db.select().from(snippets).where(eq(snippets.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined || row.ownerId !== actorId) throw new SnippetNotFoundError(id);
  return row;
}

export interface ListSnippetsOptions {
  actorId: string;
  limit?: number;
  cursor?: string;
}

export interface ListSnippetsResult {
  items: SnippetRow[];
  nextCursor?: string;
}

export async function listSnippets(
  db: Db,
  options: ListSnippetsOptions,
): Promise<ListSnippetsResult> {
  const limit = clampLimit(options.limit);
  const conds: SQL[] = [eq(snippets.ownerId, options.actorId)];
  if (options.cursor !== undefined) {
    const after = decodeCursor(options.cursor);
    conds.push(
      sql`(${snippets.createdAt}, ${snippets.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
    );
  }

  const rows = await db
    .select()
    .from(snippets)
    .where(and(...conds))
    .orderBy(asc(snippets.createdAt), asc(snippets.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  if (rows.length > limit) {
    const last = items[items.length - 1]!;
    return { items, nextCursor: encodeCursor(last.createdAt, last.id) };
  }
  return { items };
}

export interface UpdateSnippetInput {
  actorId: string;
  shortcut?: string;
  body?: string;
}

export async function updateSnippet(
  db: Db,
  id: string,
  input: UpdateSnippetInput,
): Promise<SnippetRow> {
  await assertActiveUser(db, input.actorId);
  await getSnippet(db, id, input.actorId); // NOT_FOUND if not owned

  const rows = await db
    .update(snippets)
    .set({
      ...(input.shortcut !== undefined ? { shortcut: input.shortcut } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(snippets.id, id))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new SnippetNotFoundError(id);
  return row;
}

export async function deleteSnippet(db: Db, id: string, actorId: string): Promise<void> {
  await assertActiveUser(db, actorId);
  await getSnippet(db, id, actorId); // NOT_FOUND if not owned
  await db.delete(snippets).where(eq(snippets.id, id));
}
