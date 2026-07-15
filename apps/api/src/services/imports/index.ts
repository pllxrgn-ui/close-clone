/**
 * CSV import engine (Task 4f) public surface. The Fastify route (routes/
 * imports.ts) and any future caller import from here; internals (parser, mapper,
 * planner, committer) stay behind this barrel.
 */

export { ImportStorage, FileTooLargeError } from './storage.ts';
export { readFirstFilePart, parseBoundary, MultipartError } from './multipart.ts';
export {
  createImport,
  dryRunImport,
  parseDryRunBody,
  MappingValidationError,
  ImportNotDryRunnableError,
  type CreateImportInput,
  type DryRunInput,
} from './engine.ts';
export {
  commitImport,
  CommitError,
  ImportNotFoundError,
  AlreadyCommittedError,
  CommitInProgressError,
  ImportNotCommittableError,
  ImportPlanMissingError,
  type CommitOptions,
  type CommitOutcome,
} from './commit.ts';
export {
  importMappingSchema,
  dedupeConfigSchema,
  type ImportMapping,
  type DedupeConfig,
  type ImportPlan,
  type ImportCounts,
  type RowPlan,
} from './types.ts';
