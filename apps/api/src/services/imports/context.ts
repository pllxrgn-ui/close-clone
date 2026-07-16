import { eq } from 'drizzle-orm';

import { customFieldDefs, leadStatuses, users, type Db } from '../../db/index.ts';
import { batchFuzzyMatch } from './dedupe.ts';
import type { CustomFieldSpec, MappingContext } from './mapping.ts';
import type { FuzzyResolver } from './plan.ts';

/**
 * Loads the DB-derived pieces the mapper + planner need (Task 4f): lead-entity
 * custom-field specs (typed per custom_field_defs, C1/C3), lead-status labels,
 * and users (for `owner`/`user`-typed cells). Read once per dry-run; the result
 * is the immutable `MappingContext` handed to `mapRecord`.
 */

function normalizeOptions(options: unknown): string[] | null {
  if (!Array.isArray(options)) return null;
  return options.map((o) => String(o));
}

export async function loadMappingContext(db: Db): Promise<MappingContext> {
  const customFields = new Map<string, CustomFieldSpec>();
  const defs = await db
    .select({
      key: customFieldDefs.key,
      type: customFieldDefs.type,
      options: customFieldDefs.options,
    })
    .from(customFieldDefs)
    .where(eq(customFieldDefs.entity, 'lead'));
  for (const d of defs) {
    customFields.set(d.key, { key: d.key, type: d.type, options: normalizeOptions(d.options) });
  }

  const statusByLabel = new Map<string, string>();
  const statuses = await db
    .select({ id: leadStatuses.id, label: leadStatuses.label })
    .from(leadStatuses);
  for (const s of statuses) statusByLabel.set(s.label.toLowerCase(), s.id);

  const userByEmail = new Map<string, string>();
  const userById = new Set<string>();
  const rows = await db.select({ id: users.id, email: users.email }).from(users);
  for (const u of rows) {
    userByEmail.set(u.email.toLowerCase(), u.id);
    userById.add(u.id);
  }

  return { customFields, statusByLabel, userByEmail, userById };
}

/** A `FuzzyResolver` backed by the batched pg_trgm query against `db`. */
export function makeFuzzyResolver(db: Db): FuzzyResolver {
  return (names, threshold) => batchFuzzyMatch(db, names, threshold);
}
