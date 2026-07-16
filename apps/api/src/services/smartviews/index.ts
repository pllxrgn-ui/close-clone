/**
 * Smart-view service barrel (Task R3, CONTRACTS §C7 `smart-views`). CRUD + the
 * `{dsl|ast}` preview, plus the compiler-execution helpers (the SINGLE query
 * authority, C3) reused by the bulk-action engine to resolve a target set.
 */
export {
  SmartViewService,
  SmartViewInputError,
  ParseError,
  parseRawAst,
  type SmartViewRecord,
  type SmartViewServiceDeps,
  type SmartViewCreateInput,
  type SmartViewUpdateInput,
  type SmartViewPreviewInput,
  type SmartViewPreviewResult,
} from './service.ts';

export {
  loadLeadFieldCatalog,
  buildCompileContext,
  resolveTargetIds,
  hydrateLeads,
  runIdPage,
  countEstimate,
  BULK_PAGE_SIZE,
  MAX_BULK_TARGETS,
  type IdPage,
  type ResolvedTargets,
} from './query.ts';

export {
  rawClientOf,
  encodeCursor,
  decodeCursor,
  toIso,
  toIsoRequired,
  LEAD_COLUMNS,
  mapLead,
  type RawQueryable,
  type RawLeadRow,
  type CursorParts,
} from './support.ts';
