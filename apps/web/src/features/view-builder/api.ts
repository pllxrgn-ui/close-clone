/*
 * Data access for the Smart View builder. Reuses the W1 api-client (`apiRequest`)
 * and the committed smart-views + reference calls; adds only the custom-field
 * catalog fetch this feature needs (GET /admin/custom-fields, CONTRACTS §C7
 * admin/*). The response is typed to be structurally DslCustomFieldDef-compatible
 * so it can feed the parser's `fieldCatalog` directly.
 */
import type { DslCustomFieldDef, FieldType } from '@switchboard/shared';
import { apiRequest } from '../../api/client.ts';

/** A custom-field definition row as returned by GET /admin/custom-fields.
 *  Superset of {@link DslCustomFieldDef}: adds `id`/`label`/`required` for the
 *  admin surface; only key/entity/type/options are read by the DSL. */
export interface AdminCustomField {
  readonly id: string;
  readonly entity: 'lead' | 'contact' | 'opportunity';
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly options: readonly string[] | null;
  readonly required: boolean;
}

export function fetchCustomFields(signal?: AbortSignal): Promise<AdminCustomField[]> {
  return apiRequest<AdminCustomField[]>('/admin/custom-fields', signal ? { signal } : {});
}

/** Narrow the admin rows to the DSL-local catalog shape the parser consumes. */
export function toDslCatalog(fields: readonly AdminCustomField[]): DslCustomFieldDef[] {
  return fields.map((f) => ({
    key: f.key,
    entity: f.entity,
    type: f.type,
    options: f.options ? [...f.options] : null,
  }));
}
