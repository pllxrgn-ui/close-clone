/**
 * Bulk-action engine barrel (CONTRACTS §C7 `bulk`, Task R3). `POST /bulk` resolves
 * a smart-view/ast target set through the compiler and applies one action across
 * it — assign / set-status / set-dnc / clear-dnc (ActivityWriter events) · enroll
 * (sequence engine, I-DNC honored) · export (CSV/JSON).
 */
export {
  BulkService,
  BulkInputError,
  BulkTargetError,
  type BulkAction,
  type BulkInput,
  type BulkActor,
  type BulkResult,
  type BulkSummary,
  type MutationSummary,
  type EnrollSummary,
  type ExportSummary,
  type BulkServiceDeps,
} from './service.ts';

export { leadsToCsv, leadsToJson } from './csv.ts';
