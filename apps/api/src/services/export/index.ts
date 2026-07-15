/**
 * Full data export (Task 5g, build guide §5g / §1 data-ownership). Streams every
 * C1 entity to JSON-lines and/or CSV — one file per entity, deterministic column
 * order, custom fields flattened per `custom_field_defs`, secrets
 * (`oauth_tokens`, api-token `hash`) excluded, suppressions + `audit_log`
 * included. Wrapped by `export.started` / `export.completed` audit events.
 */

export {
  runExport,
  ExportError,
  type ExportFormat,
  type ExportAuditContext,
  type RunExportOptions,
  type EntityExportResult,
  type ExportManifest,
} from './exporter.ts';

export {
  EXPORT_ENTITIES,
  type ExportEntity,
  type CustomEntity,
} from './entities.ts';

export {
  csvField,
  csvHeader,
  csvRow,
  csvLine,
  jsonlRow,
  toRecord,
  type OutputColumn,
} from './serialize.ts';
