import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { asc, eq, getTableColumns, getTableName, gt } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import { customFieldDefs, type Db } from '../../db/index.ts';
import type { AuditActorType } from '../audit/index.ts';
import type { AuditWriter } from '../audit/index.ts';
import { EXPORT_ENTITIES, type CustomEntity, type ExportEntity } from './entities.ts';
import { csvHeader, csvRow, jsonlRow, type OutputColumn } from './serialize.ts';

/**
 * The streaming full-export engine (Task 5g). For every C1 entity it pages the
 * table by keyset (`id > cursor` — no OFFSET, no whole-table array in memory) and
 * writes each row straight to a `<entity>.jsonl` and/or `<entity>.csv` file, one
 * file per entity, with backpressure honored. Column order is deterministic
 * (Drizzle definition order, secrets/generated columns dropped, custom fields
 * flattened after the base columns). Wrapped by `export.started` / `export.completed`
 * audit events (build guide §5g) when an audit context is supplied.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export type ExportFormat = 'jsonl' | 'csv' | 'both';

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/** Audit binding: when present, the run is bracketed by started/completed events. */
export interface ExportAuditContext {
  writer: AuditWriter;
  actorId?: string | null;
  actorType?: AuditActorType;
  ip?: string | null;
}

export interface RunExportOptions {
  /** Directory the per-entity files are written into (created if absent). */
  outDir: string;
  format?: ExportFormat;
  /** Rows fetched per keyset page. Bounds memory. */
  batchSize?: number;
  /** Override the generated export id (a uuid; also the audit `entity_id`). */
  exportId?: string;
  /** When set, emit `export.started` before and `export.completed` after. */
  audit?: ExportAuditContext;
  /** Override the entity set (tests use a subset); defaults to every C1 entity. */
  entities?: readonly ExportEntity[];
}

export interface EntityExportResult {
  /** SQL table name (the file basename). */
  name: string;
  rows: number;
  /** Absolute paths written for this entity. */
  files: string[];
}

export interface ExportManifest {
  exportId: string;
  format: ExportFormat;
  outDir: string;
  entities: EntityExportResult[];
  totalRows: number;
}

const DEFAULT_BATCH = 1000;

// --- Backpressure-aware file writer ----------------------------------------

/** A UTF-8 file stream that awaits `drain` so memory stays bounded at scale. */
class FileWriter {
  private readonly stream: WriteStream;
  private failure: Error | null = null;

  constructor(path: string) {
    this.stream = createWriteStream(path, { encoding: 'utf8' });
    this.stream.on('error', (err: Error) => {
      this.failure = err;
    });
  }

  async write(chunk: string): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.stream.write(chunk)) {
      await once(this.stream, 'drain');
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end(() => {
        if (this.failure) reject(this.failure);
        else resolve();
      });
    });
  }
}

// --- Column resolution ------------------------------------------------------

interface ResolvedEntity {
  name: string;
  idColumn: PgColumn;
  /** Projection of the non-excluded columns (secrets are never even fetched). */
  projection: Record<string, PgColumn>;
  columns: OutputColumn[];
}

async function loadCustomKeys(db: Db, entity: CustomEntity): Promise<string[]> {
  const rows = await db
    .select({ key: customFieldDefs.key })
    .from(customFieldDefs)
    .where(eq(customFieldDefs.entity, entity))
    .orderBy(asc(customFieldDefs.key));
  return rows.map((r) => r.key);
}

async function resolveEntity(db: Db, entity: ExportEntity): Promise<ResolvedEntity> {
  const name = getTableName(entity.table);
  const cols = getTableColumns(entity.table);
  const excluded = new Set(entity.exclude ?? []);

  const projection: Record<string, PgColumn> = {};
  const columns: OutputColumn[] = [];
  for (const [jsProp, col] of Object.entries(cols)) {
    if (excluded.has(jsProp)) continue;
    projection[jsProp] = col;
    columns.push({ key: col.name, get: (row) => row[jsProp] });
  }

  const idColumn = cols['id'];
  if (idColumn === undefined) {
    throw new ExportError(`entity ${name} has no id column to keyset-paginate on`);
  }

  if (entity.customEntity) {
    const keys = await loadCustomKeys(db, entity.customEntity);
    for (const key of keys) {
      columns.push({
        key: `custom.${key}`,
        get: (row) => {
          const custom = row['custom'];
          return custom !== null && typeof custom === 'object'
            ? (custom as Record<string, unknown>)[key]
            : undefined;
        },
      });
    }
  }

  return { name, idColumn, projection, columns };
}

// --- Keyset pager -----------------------------------------------------------

async function* pageRows(
  db: Db,
  table: PgTable,
  idColumn: PgColumn,
  projection: Record<string, PgColumn>,
  batchSize: number,
): AsyncGenerator<Record<string, unknown>[]> {
  let cursor: string | null = null;
  for (;;) {
    const batch = (await db
      .select(projection)
      .from(table)
      .where(cursor === null ? undefined : gt(idColumn, cursor))
      .orderBy(asc(idColumn))
      .limit(batchSize)) as unknown as Record<string, unknown>[];

    if (batch.length === 0) return;
    yield batch;
    if (batch.length < batchSize) return;

    const last = batch[batch.length - 1];
    const lastId = last?.['id'];
    if (typeof lastId !== 'string') return;
    cursor = lastId;
  }
}

// --- Per-entity export ------------------------------------------------------

async function exportEntity(
  db: Db,
  entity: ExportEntity,
  outDir: string,
  format: ExportFormat,
  batchSize: number,
): Promise<EntityExportResult> {
  const resolved = await resolveEntity(db, entity);
  const files: string[] = [];

  let jsonlWriter: FileWriter | null = null;
  let csvWriter: FileWriter | null = null;
  if (format === 'jsonl' || format === 'both') {
    const path = join(outDir, `${resolved.name}.jsonl`);
    jsonlWriter = new FileWriter(path);
    files.push(path);
  }
  if (format === 'csv' || format === 'both') {
    const path = join(outDir, `${resolved.name}.csv`);
    csvWriter = new FileWriter(path);
    files.push(path);
    await csvWriter.write(csvHeader(resolved.columns));
  }

  let rows = 0;
  try {
    for await (const batch of pageRows(
      db,
      entity.table,
      resolved.idColumn,
      resolved.projection,
      batchSize,
    )) {
      for (const row of batch) {
        if (jsonlWriter) await jsonlWriter.write(jsonlRow(row, resolved.columns));
        if (csvWriter) await csvWriter.write(csvRow(row, resolved.columns));
        rows += 1;
      }
    }
  } finally {
    if (jsonlWriter) await jsonlWriter.close();
    if (csvWriter) await csvWriter.close();
  }

  return { name: resolved.name, rows, files };
}

// --- Public entrypoint ------------------------------------------------------

export async function runExport(db: Db, opts: RunExportOptions): Promise<ExportManifest> {
  const format: ExportFormat = opts.format ?? 'both';
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const exportId = opts.exportId ?? randomUUID();
  const entities = opts.entities ?? EXPORT_ENTITIES;

  await mkdir(opts.outDir, { recursive: true });

  if (opts.audit) {
    await opts.audit.writer.write({
      action: 'export.started',
      entity: 'export',
      entityId: exportId,
      actorType: opts.audit.actorType ?? 'system',
      actorId: opts.audit.actorId ?? null,
      ip: opts.audit.ip ?? null,
      after: { format, outDir: opts.outDir, entityCount: entities.length },
    });
  }

  const results: EntityExportResult[] = [];
  let totalRows = 0;
  for (const entity of entities) {
    const result = await exportEntity(db, entity, opts.outDir, format, batchSize);
    results.push(result);
    totalRows += result.rows;
  }

  if (opts.audit) {
    await opts.audit.writer.write({
      action: 'export.completed',
      entity: 'export',
      entityId: exportId,
      actorType: opts.audit.actorType ?? 'system',
      actorId: opts.audit.actorId ?? null,
      ip: opts.audit.ip ?? null,
      after: {
        format,
        totalRows,
        entities: results.map((r) => ({ name: r.name, rows: r.rows })),
      },
    });
  }

  return { exportId, format, outDir: opts.outDir, entities: results, totalRows };
}
