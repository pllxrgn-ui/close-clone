import type { AuditActorType } from '../audit/actions.ts';

/**
 * Shared admin-CRUD service shapes. The domain entity DTOs (User, OrgSettings,
 * Suppression, CustomFieldDef) come from `@switchboard/shared` and are never
 * re-declared; this file only holds the small request/actor envelopes the admin
 * services exchange with their route.
 */

/**
 * The acting admin, resolved from request context by the route (Task 5a wires the
 * real resolver; until then `id` is null and audit rows carry a null actor, which
 * the C1 `audit_log.actor_id` column permits).
 */
export interface AdminActor {
  id: string | null;
  type: AuditActorType;
  ip: string | null;
}

/**
 * A custom-field definition row exactly as the web's `GET /admin/custom-fields`
 * consumers bind it (feature `CustomFieldRow` + view-builder `AdminCustomField`):
 * the seven identity/display fields, NO timestamps. Kept structurally identical so
 * flipping the web to the real API is a drop-in.
 */
export interface CustomFieldRow {
  id: string;
  entity: 'lead' | 'contact' | 'opportunity';
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'user';
  options: string[] | null;
  required: boolean;
}
