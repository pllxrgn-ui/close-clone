/**
 * Admin-CRUD services (CONTRACTS §C7 `admin/*`, admin RBAC): the real home for the
 * users / custom-fields / org-settings / suppressions surfaces the web MVP served
 * only from MSW + PGlite dev shims. Each mutation is audited through the 5b writer;
 * compliance-touching writes (recording flip, suppression release/add) reuse the
 * sanctioned engine services, never a raw column write.
 */

export {
  AdminError,
  AdminValidationError,
  AdminConflictError,
  AdminNotFoundError,
  AdminForbiddenError,
} from './errors.ts';
export type { AdminActor, CustomFieldRow } from './types.ts';

export {
  listCustomFields,
  createCustomField,
  updateCustomField,
  deleteCustomField,
  type CreateCustomFieldInput,
  type UpdateCustomFieldInput,
} from './custom-fields.ts';

export { listUsers, setUserActive, type SetUserActiveInput } from './users.ts';

export { getOrgSettings, patchOrgSettings, type PatchOrgSettingsInput } from './org-settings.ts';

export {
  listSuppressions,
  addSuppression,
  releaseSuppressionById,
  type ListSuppressionsInput,
  type SuppressionPage,
  type AddSuppressionInput,
  type ReleaseSuppressionInput,
} from './suppressions.ts';
