import { and, asc, eq } from 'drizzle-orm';
import { customFieldTypeValues } from '@switchboard/shared';
import { customFieldDefs, type Db } from '../../db/index.ts';
import { writeAudit } from '../audit/index.ts';
import { AdminConflictError, AdminNotFoundError, AdminValidationError } from './errors.ts';
import type { AdminActor, CustomFieldRow } from './types.ts';

/**
 * Custom-field definition CRUD (CONTRACTS §C1 `custom_field_defs`, §C7 `admin/*`).
 * The real home for the web's `GET/POST /admin/custom-fields` (+ the PATCH/DELETE
 * the task adds). Validation mirrors the MSW handler byte-for-byte — same messages,
 * same `{ field }` details — so the create-field form behaves identically when the
 * web flips to the real API. Every mutation writes its `admin.custom_field_*` audit
 * row IN THE SAME TRANSACTION as the change (the ledger can't drift from reality).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
type Entity = 'lead' | 'contact' | 'opportunity';
type FieldType = (typeof customFieldTypeValues)[number];

/** Project a persisted row to the timestamp-free web shape. */
function toRow(r: {
  id: string;
  entity: string;
  key: string;
  label: string;
  type: string;
  options: unknown[] | null;
  required: boolean;
}): CustomFieldRow {
  return {
    id: r.id,
    entity: r.entity as Entity,
    key: r.key,
    label: r.label,
    type: r.type as FieldType,
    options: r.options === null ? null : r.options.map((o) => String(o)),
    required: r.required,
  };
}

const SELECT_COLS = {
  id: customFieldDefs.id,
  entity: customFieldDefs.entity,
  key: customFieldDefs.key,
  label: customFieldDefs.label,
  type: customFieldDefs.type,
  options: customFieldDefs.options,
  required: customFieldDefs.required,
} as const;

/** List every custom-field definition (bare array, ordered for a stable catalog). */
export async function listCustomFields(db: Db): Promise<CustomFieldRow[]> {
  const rows = await db
    .select(SELECT_COLS)
    .from(customFieldDefs)
    .orderBy(asc(customFieldDefs.entity), asc(customFieldDefs.key));
  return rows.map(toRow);
}

export interface CreateCustomFieldInput {
  entity: unknown;
  key: unknown;
  label: unknown;
  type: unknown;
  options?: unknown;
  required?: unknown;
}

/**
 * Create a custom-field definition. Validation order + messages match the MSW so
 * the web form's inline errors are unchanged; a `(entity, key)` collision is a
 * CONFLICT (both a pre-check and a 23505 backstop against a concurrent create).
 */
export async function createCustomField(
  db: Db,
  input: CreateCustomFieldInput,
  actor: AdminActor,
): Promise<CustomFieldRow> {
  const entity = input.entity;
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const type = input.type;

  if (entity !== 'lead' && entity !== 'contact' && entity !== 'opportunity') {
    throw new AdminValidationError('entity must be lead, contact, or opportunity');
  }
  if (!SNAKE_CASE.test(key)) {
    throw new AdminValidationError('key must be snake_case (a–z, 0–9, _)', { field: 'key' });
  }
  if (label.length === 0) {
    throw new AdminValidationError('label is required', { field: 'label' });
  }
  if (typeof type !== 'string' || !(customFieldTypeValues as readonly string[]).includes(type)) {
    throw new AdminValidationError(`type must be one of ${customFieldTypeValues.join(', ')}`, {
      field: 'type',
    });
  }
  const options =
    type === 'select' && Array.isArray(input.options)
      ? input.options.map((o) => String(o)).filter((o) => o.length > 0)
      : null;
  if (type === 'select' && (options === null || options.length === 0)) {
    throw new AdminValidationError('select fields need at least one option', { field: 'options' });
  }

  const existing = await db
    .select({ id: customFieldDefs.id })
    .from(customFieldDefs)
    .where(and(eq(customFieldDefs.entity, entity), eq(customFieldDefs.key, key)))
    .limit(1);
  if (existing[0] !== undefined) {
    throw new AdminConflictError(`A ${entity} field with key "${key}" already exists`, {
      field: 'key',
    });
  }

  try {
    return await db.transaction(async (txRaw) => {
      const tx = txRaw as Db;
      const inserted = await tx
        .insert(customFieldDefs)
        .values({
          entity,
          key,
          label,
          type: type as FieldType,
          options,
          required: input.required === true,
        })
        .returning(SELECT_COLS);
      const row = toRow(inserted[0]!);
      await writeAudit(tx, {
        action: 'admin.custom_field_created',
        entity: 'custom_field_def',
        entityId: row.id,
        actorType: actor.type,
        actorId: actor.id,
        after: { entity: row.entity, key: row.key, label: row.label, type: row.type },
        ip: actor.ip,
      });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AdminConflictError(`A ${String(entity)} field with key "${key}" already exists`, {
        field: 'key',
      });
    }
    throw err;
  }
}

export interface UpdateCustomFieldInput {
  label?: unknown;
  required?: unknown;
  options?: unknown;
}

/**
 * Update a field's presentation (label / required / select options). Identity
 * columns (entity, key, type) are immutable — changing them would orphan stored
 * `custom` jsonb values, so they are not patchable here.
 */
export async function updateCustomField(
  db: Db,
  id: string,
  patch: UpdateCustomFieldInput,
  actor: AdminActor,
): Promise<CustomFieldRow> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const current = await tx
      .select(SELECT_COLS)
      .from(customFieldDefs)
      .where(eq(customFieldDefs.id, id))
      .limit(1);
    const before = current[0];
    if (before === undefined) throw new AdminNotFoundError('Custom field not found');

    const set: Partial<typeof customFieldDefs.$inferInsert> = {};
    if (patch.label !== undefined) {
      const label = typeof patch.label === 'string' ? patch.label.trim() : '';
      if (label.length === 0) {
        throw new AdminValidationError('label is required', { field: 'label' });
      }
      set.label = label;
    }
    if (patch.required !== undefined) {
      if (typeof patch.required !== 'boolean') {
        throw new AdminValidationError('required must be a boolean', { field: 'required' });
      }
      set.required = patch.required;
    }
    if (patch.options !== undefined) {
      if (before.type !== 'select') {
        throw new AdminValidationError('options apply only to select fields', { field: 'options' });
      }
      if (!Array.isArray(patch.options)) {
        throw new AdminValidationError('options must be an array', { field: 'options' });
      }
      const options = patch.options.map((o) => String(o)).filter((o) => o.length > 0);
      if (options.length === 0) {
        throw new AdminValidationError('select fields need at least one option', {
          field: 'options',
        });
      }
      set.options = options;
    }
    if (Object.keys(set).length === 0) {
      throw new AdminValidationError('no updatable fields supplied');
    }

    const updated = await tx
      .update(customFieldDefs)
      .set(set)
      .where(eq(customFieldDefs.id, id))
      .returning(SELECT_COLS);
    const row = toRow(updated[0]!);
    await writeAudit(tx, {
      action: 'admin.custom_field_updated',
      entity: 'custom_field_def',
      entityId: id,
      actorType: actor.type,
      actorId: actor.id,
      before: { label: before.label, required: before.required, options: before.options },
      after: { label: row.label, required: row.required, options: row.options },
      ip: actor.ip,
    });
    return row;
  });
}

/** Delete a custom-field definition (audited). The stored `custom` jsonb values on
 *  records are left untouched — a deleted def just stops being offered. */
export async function deleteCustomField(db: Db, id: string, actor: AdminActor): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    const current = await tx
      .select(SELECT_COLS)
      .from(customFieldDefs)
      .where(eq(customFieldDefs.id, id))
      .limit(1);
    const before = current[0];
    if (before === undefined) throw new AdminNotFoundError('Custom field not found');

    await tx.delete(customFieldDefs).where(eq(customFieldDefs.id, id));
    await writeAudit(tx, {
      action: 'admin.custom_field_deleted',
      entity: 'custom_field_def',
      entityId: id,
      actorType: actor.type,
      actorId: actor.id,
      before: { entity: before.entity, key: before.key, label: before.label, type: before.type },
      ip: actor.ip,
    });
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23505') return true;
  const cause = (err as { cause?: unknown }).cause;
  if (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === '23505'
  ) {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('duplicate key value');
}
