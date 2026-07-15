/**
 * Audit log (Task 5b, CONTRACTS §C1). The append-only ledger of auth events,
 * admin changes, compliance-switch flips, exports, and hard-deletes. Every module
 * writes through the single {@link writeAudit} path (or the {@link AuditWriter}
 * wrapper); the read side ({@link AuditQueryService}) backs
 * `GET /api/v1/admin/audit-log`. The DB-level append-only guarantee is enforced by
 * migration 0011's trigger; snapshots are redacted on write and read.
 */

export {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  auditActionSchema,
  auditSnapshotSchema,
  auditWriteInputSchema,
  type AuditAction,
  type AuditActorType,
  type AuditEntity,
  type AuditSnapshot,
} from './actions.ts';

export { redactSnapshot, isSensitiveKey, REDACTED } from './redaction.ts';

export {
  AuditWriter,
  writeAudit,
  requestActor,
  releaseSuppression,
  AuditError,
  AuditWriteError,
  MissingReasonError,
  SuppressionNotFoundError,
  SuppressionAlreadyReleasedError,
  type AuditWriteInput,
  type AuditLogRow,
  type AuditRequestLike,
  type ActorHint,
  type ResolvedActor,
  type ReleaseSuppressionInput,
  type ReleaseSuppressionResult,
} from './writer.ts';

export {
  AuditQueryService,
  InvalidAuditCursorError,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type AuditQueryFilter,
  type AuditPage,
  type AuditLogItem,
} from './query.ts';
