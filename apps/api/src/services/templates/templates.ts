import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
import { templateChannelValues } from '@switchboard/shared';
import { templates, type Db } from '../../db/index.ts';
import {
  assertActiveUser,
  clampLimit,
  decodeCursor,
  encodeCursor,
} from './access.ts';

/**
 * Templates CRUD (task 2d, CONTRACTS §C1 templates: `channel`, `shared`/`owner`).
 *
 * Access model:
 *   - readable  ⇔ `owner_id = actor` OR `shared = true`
 *   - mutable   ⇔ `owner_id = actor`  (owner only; admin override is 5a's concern)
 * A private template is INVISIBLE to a non-owner (`TemplateNotFoundError`, never
 * leaked); a shared template is readable but a non-owner editing it is
 * `TemplateForbiddenError`. Every mutation requires a valid active actor.
 *
 * Bodies are stored verbatim — the merge renderer (send path) is what escapes
 * untrusted field VALUES; the template layout itself is authored content.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type TemplateChannel = (typeof templateChannelValues)[number];
export type TemplateRow = typeof templates.$inferSelect;

export class TemplateNotFoundError extends Error {
  readonly templateId: string;
  constructor(templateId: string) {
    super(`template ${templateId} not found`);
    this.name = 'TemplateNotFoundError';
    this.templateId = templateId;
  }
}

export class TemplateForbiddenError extends Error {
  readonly templateId: string;
  constructor(templateId: string) {
    super(`template ${templateId} is not owned by the actor`);
    this.name = 'TemplateForbiddenError';
    this.templateId = templateId;
  }
}

export interface CreateTemplateInput {
  actorId: string;
  name: string;
  channel: TemplateChannel;
  subject?: string | null;
  body: string;
  shared?: boolean;
}

export async function createTemplate(db: Db, input: CreateTemplateInput): Promise<TemplateRow> {
  await assertActiveUser(db, input.actorId);
  const rows = await db
    .insert(templates)
    .values({
      name: input.name,
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      ownerId: input.actorId,
      shared: input.shared ?? false,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('createTemplate: insert returned no row');
  return row;
}

/** Load a template the actor may READ (owner or shared), else NOT_FOUND. */
export async function getTemplate(db: Db, id: string, actorId: string): Promise<TemplateRow> {
  const rows = await db.select().from(templates).where(eq(templates.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new TemplateNotFoundError(id);
  const visible = row.ownerId === actorId || row.shared;
  if (!visible) throw new TemplateNotFoundError(id);
  return row;
}

export interface ListTemplatesOptions {
  actorId: string;
  channel?: TemplateChannel;
  limit?: number;
  cursor?: string;
}

export interface ListTemplatesResult {
  items: TemplateRow[];
  nextCursor?: string;
}

/** Page templates visible to the actor (own + shared), keyset over (created_at, id). */
export async function listTemplates(
  db: Db,
  options: ListTemplatesOptions,
): Promise<ListTemplatesResult> {
  const limit = clampLimit(options.limit);
  const conds: SQL[] = [];
  const visible = or(eq(templates.ownerId, options.actorId), eq(templates.shared, true));
  if (visible !== undefined) conds.push(visible);
  if (options.channel !== undefined) conds.push(eq(templates.channel, options.channel));
  if (options.cursor !== undefined) {
    const after = decodeCursor(options.cursor);
    conds.push(
      sql`(${templates.createdAt}, ${templates.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
    );
  }

  const rows = await db
    .select()
    .from(templates)
    .where(and(...conds))
    .orderBy(asc(templates.createdAt), asc(templates.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  if (rows.length > limit) {
    const last = items[items.length - 1]!;
    return { items, nextCursor: encodeCursor(last.createdAt, last.id) };
  }
  return { items };
}

/** Load a template the actor OWNS, else FORBIDDEN (visible) / NOT_FOUND (invisible). */
async function loadOwned(db: Db, id: string, actorId: string): Promise<TemplateRow> {
  const row = await getTemplate(db, id, actorId); // throws NOT_FOUND if invisible
  if (row.ownerId !== actorId) throw new TemplateForbiddenError(id);
  return row;
}

export interface UpdateTemplateInput {
  actorId: string;
  name?: string;
  channel?: TemplateChannel;
  subject?: string | null;
  body?: string;
  shared?: boolean;
}

export async function updateTemplate(
  db: Db,
  id: string,
  input: UpdateTemplateInput,
): Promise<TemplateRow> {
  await assertActiveUser(db, input.actorId);
  await loadOwned(db, id, input.actorId);

  const rows = await db
    .update(templates)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.shared !== undefined ? { shared: input.shared } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(templates.id, id))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new TemplateNotFoundError(id);
  return row;
}

export async function deleteTemplate(db: Db, id: string, actorId: string): Promise<void> {
  await assertActiveUser(db, actorId);
  await loadOwned(db, id, actorId);
  await db.delete(templates).where(eq(templates.id, id));
}
