/*
 * The import feature's in-memory store — module-scope state the MSW handlers read
 * and write, mirroring the server's `imports` C1 row through its lifecycle
 * (uploaded → dry_run → committed | failed). The uploaded CSV text lives here
 * (the server keeps bytes in ImportStorage); the persisted dry-run plan is
 * replayed verbatim at commit, exactly like the real committer. Writes survive
 * route changes within a session and reset on reload; `resetImportStore()` gives
 * colocated tests a clean slate.
 *
 * `suppressedEmails` is this feature's own demo suppression source (the "build
 * your own seed" fence): the sample file deliberately contains one suppressed
 * address so a committed import demonstrates the compliance rail — imported and
 * flagged, never contacted.
 */
import type {
  CommitCounters,
  DedupeConfig,
  ImportMapping,
  ImportPlan,
  ImportResource,
} from '../types.ts';

export type ImportStatus = 'uploaded' | 'dry_run' | 'committing' | 'committed' | 'failed';

export interface ImportRecord {
  id: string;
  filename: string;
  status: ImportStatus;
  rowCount: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The uploaded document, kept for the dry-run parse (server keeps bytes). */
  csvText: string;
  mapping: ImportMapping | null;
  dedupe: DedupeConfig | null;
  plan: ImportPlan | null;
  counters: CommitCounters | null;
}

export interface ImportStoreState {
  imports: Map<string, ImportRecord>;
  /** Globally suppressed addresses (unsubscribe/bounce) — lowercased. */
  suppressedEmails: Set<string>;
}

/** One address the sample file carries, so a committed sample shows the rail. */
function seedSuppressed(): Set<string> {
  return new Set(['amir@kestrel-provisions.example.com']);
}

export const importStore: ImportStoreState = {
  imports: new Map(),
  suppressedEmails: seedSuppressed(),
};

/** Reset to the initial (empty) state — test isolation. */
export function resetImportStore(): void {
  importStore.imports.clear();
  importStore.suppressedEmails = seedSuppressed();
}

/** Public REST projection of a record (internal csvText/plan blobs omitted). */
export function toResource(record: ImportRecord): ImportResource {
  return {
    id: record.id,
    filename: record.filename,
    status: record.status,
    rowCount: record.rowCount,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
