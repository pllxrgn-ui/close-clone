import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { imports, type Db, type ImportRow } from '../../db/index.ts';
import { loadMappingContext, makeFuzzyResolver } from './context.ts';
import { buildExistingIndex } from './dedupe.ts';
import { ImportNotFoundError } from './commit.ts';
import { validateMappingTargets } from './mapping.ts';
import { parseCsvRecords } from './csv.ts';
import { buildPlan } from './plan.ts';
import type { ImportStorage } from './storage.ts';
import {
  dedupeConfigSchema,
  importMappingSchema,
  type DedupeConfig,
  type ImportMapping,
  type ImportPlan,
} from './types.ts';

/**
 * Import engine orchestration (Task 4f). Wires the streaming parser, DB context,
 * dedupe snapshot, and planner into the C7 flow:
 *   createImport (store file, row='uploaded')
 *     → dryRunImport (parse → plan, NO writes, persist to dry_run_result)
 *     → commitImport (see commit.ts).
 * The dry-run runs the FULL pipeline against the DB but writes nothing to
 * leads/contacts/activities — only the import row's own plan columns are updated.
 *
 * Import-safe for direct `node` execution (no enums / namespaces).
 */

export class MappingValidationError extends Error {
  readonly details: string[];
  constructor(details: string[]) {
    super('mapping is invalid');
    this.name = 'MappingValidationError';
    this.details = details;
  }
}

/** Import is committed/committing and can no longer be (re-)dry-run. */
export class ImportNotDryRunnableError extends Error {
  readonly importId: string;
  readonly status: string;
  constructor(importId: string, status: string) {
    super(`import ${importId} cannot be dry-run from '${status}'`);
    this.name = 'ImportNotDryRunnableError';
    this.importId = importId;
    this.status = status;
  }
}

export interface CreateImportInput {
  createdBy: string;
  filename: string;
  source: AsyncIterable<Buffer>;
  maxBytes?: number;
}

/** Store the uploaded CSV and create its 'uploaded' import row. */
export async function createImport(
  db: Db,
  storage: ImportStorage,
  input: CreateImportInput,
): Promise<ImportRow> {
  const id = randomUUID();
  const fileRef = storage.keyFor(id);
  const saveOpts = input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes };
  await storage.save(fileRef, input.source, saveOpts);
  const [row] = await db
    .insert(imports)
    .values({
      id,
      createdBy: input.createdBy,
      filename: input.filename,
      fileRef,
      status: 'uploaded',
    })
    .returning();
  if (!row) throw new Error('failed to create import row');
  return row;
}

export interface DryRunInput {
  mapping: ImportMapping;
  dedupe: DedupeConfig;
}

/** Parse the raw request bodies for dry-run (mapping + optional dedupe config). */
export function parseDryRunBody(body: unknown): DryRunInput {
  const shape = importMappingSchema.parse((body as { mapping?: unknown } | null)?.mapping);
  const dedupe = dedupeConfigSchema.parse((body as { dedupeConfig?: unknown } | null)?.dedupeConfig ?? {});
  return { mapping: shape, dedupe };
}

/**
 * Run the dry-run pipeline for an import: validate the mapping, stream + plan the
 * stored CSV against the pre-import dedupe snapshot, and persist the plan +
 * mapping + dedupe config + row_count to the import row (status → 'dry_run').
 * Writes NOTHING to leads/contacts/activities.
 */
export async function dryRunImport(
  db: Db,
  storage: ImportStorage,
  importId: string,
  input: DryRunInput,
): Promise<ImportPlan> {
  const [row] = await db
    .select({ status: imports.status, fileRef: imports.fileRef })
    .from(imports)
    .where(eq(imports.id, importId));
  if (row === undefined) throw new ImportNotFoundError(importId);
  if (row.status === 'committing' || row.status === 'committed') {
    throw new ImportNotDryRunnableError(importId, row.status);
  }

  const ctx = await loadMappingContext(db);
  const targetErrors = validateMappingTargets(input.mapping, ctx);
  if (targetErrors.length > 0) throw new MappingValidationError(targetErrors);

  const existing = await buildExistingIndex(db);
  const plan = await buildPlan(parseCsvRecords(storage.open(row.fileRef)), {
    mapping: input.mapping,
    dedupe: input.dedupe,
    ctx,
    existing,
    fuzzy: makeFuzzyResolver(db),
    newLeadId: () => randomUUID(),
    newContactId: () => randomUUID(),
  });

  await db
    .update(imports)
    .set({
      mapping: input.mapping as unknown as Record<string, unknown>,
      dedupeConfig: input.dedupe as unknown as Record<string, unknown>,
      dryRunResult: plan as unknown as Record<string, unknown>,
      rowCount: plan.counts.totalRows,
      status: 'dry_run',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(imports.id, importId));

  return plan;
}
