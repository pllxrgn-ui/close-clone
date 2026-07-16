import { z } from 'zod';
import { auditActorTypeSchema } from '@switchboard/shared';

/**
 * Audit action catalog (Task 5b). The `audit_log` table (CONTRACTS §C1) is the
 * append-only, tamper-evident ledger of everything the platform must be able to
 * answer "who did this, when, and to what" about: auth events, admin changes,
 * compliance-switch flips, exports, and hard-deletes (build guide §5b).
 *
 * `AUDIT_ACTIONS` is the closed-but-extensible union every module writes through
 * the single {@link import('./writer.ts').writeAudit} path. Adding an action is a
 * one-line edit here; callers then get autocomplete and a compile error on typos.
 * The DB column is free `text`, so the query surface filters on an arbitrary
 * string (a historical action need not still be in the catalog) — writes are
 * constrained, reads are permissive.
 *
 * This file is import-safe for direct `node` execution (no enums / namespaces /
 * parameter properties — the host type-stripping constraint).
 */
export const AUDIT_ACTIONS = [
  // Authn/authz (build guide §5b: "auth events"). Logout added for 5a (D-028).
  'auth.login',
  'auth.denied',
  'auth.logout',
  // Internal API tokens + outbound webhook lifecycle (5c, D-028).
  'api_token.created',
  'api_token.revoked',
  'webhook_subscription.created',
  'webhook_subscription.updated',
  'webhook_subscription.deleted',
  // Admin surface (build guide §5b: "admin changes").
  'admin.user_changed',
  'admin.custom_field_created',
  'admin.custom_field_updated',
  'admin.custom_field_deleted',
  // Compliance switches — org_settings.recording_enabled et al. (CONTRACTS §I-REC).
  'admin.compliance_switch_changed',
  // The blessed suppression-release path (CONTRACTS §C1 released_*; §4.5).
  'admin.suppression_released',
  // Data export (build guide §5g: full JSON/CSV export).
  'export.started',
  'export.completed',
  // Hard delete with audit trail (build guide §5g).
  'delete.hard_requested',
  'delete.hard_completed',
  // Bulk mutations that reshape records.
  'import.committed',
  'lead.merged',
] as const;

export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Actor kind (CONTRACTS §C1). Derived here since shared exports only the schema. */
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;

/**
 * Known `entity` values the platform audits. `entity` is free `text` in the
 * schema and is NOT restricted to this list at write time — the catalog is a
 * convenience/documentation aid so new modules can audit new entity kinds
 * without a contract bump. Writes only require a non-empty string.
 */
export const AUDIT_ENTITIES = [
  'user',
  'custom_field_def',
  'org_settings',
  'suppression',
  'export',
  'import',
  'lead',
  'auth',
  'api_token',
  'email_account',
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

/**
 * A before/after snapshot: a JSON object of the record's state. Snapshots are
 * redacted (see `./redaction.ts`) before persist AND on read, so OAuth token
 * material can never leak through the audit trail even if a caller hands it in.
 */
export const auditSnapshotSchema = z.record(z.unknown());
export type AuditSnapshot = z.infer<typeof auditSnapshotSchema>;

/**
 * Runtime validation shape for a write (CONTRACTS §C1 columns). `actor_type` is
 * the C1 enum (`user | system | api_token`); `entityId`/`actorId` are uuids when
 * present; `before`/`after` are JSON objects; `at` may be overridden (defaults to
 * the DB `now()`). Kept as a schema so bad input is rejected before it can reach
 * the ledger — the audit trail must not itself carry malformed rows.
 */
export const auditWriteInputSchema = z.object({
  action: auditActionSchema,
  entity: z.string().min(1),
  entityId: z.string().uuid().nullish(),
  actorType: auditActorTypeSchema,
  actorId: z.string().uuid().nullish(),
  before: auditSnapshotSchema.nullish(),
  after: auditSnapshotSchema.nullish(),
  reason: z.string().nullish(),
  ip: z.string().nullish(),
  at: z.union([z.string(), z.date()]).optional(),
});
