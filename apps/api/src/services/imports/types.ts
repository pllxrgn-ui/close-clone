import { z } from 'zod';

/**
 * Import pipeline contract types (Task 4f). The request-facing config
 * (`mapping`, `dedupeConfig`) is zod-validated; the internal plan/disposition
 * shapes are plain JSON-serialisable interfaces (they are persisted verbatim to
 * `imports.dry_run_result` and replayed by the committer, so `null` is used in
 * place of optional-undefined to keep the JSON round-trip exact).
 *
 * These live here rather than in `@switchboard/shared` because Task 4f's
 * allowlist excludes the shared package (reported as friction — hoist at merge).
 */

// --- Column mapping ---------------------------------------------------------

export const LEAD_TARGET_FIELDS = ['name', 'url', 'description', 'dnc', 'status', 'owner'] as const;
export const CONTACT_TARGET_FIELDS = ['name', 'title', 'email', 'phone'] as const;

export type LeadTargetField = (typeof LEAD_TARGET_FIELDS)[number];
export type ContactTargetField = (typeof CONTACT_TARGET_FIELDS)[number];

/** Parsed, structured form of a mapping target string. */
export type MappingTarget =
  | { kind: 'ignore' }
  | { kind: 'lead'; field: LeadTargetField }
  | { kind: 'contact'; field: ContactTargetField }
  | { kind: 'custom'; key: string };

export const importColumnSchema = z.object({
  /** Source column, identified by its header string. */
  source: z.string().min(1),
  /** Target: `ignore` | `lead.<field>` | `contact.<field>` | `custom.<key>`. */
  target: z.string().min(1),
});
export type ImportColumn = z.infer<typeof importColumnSchema>;

export const importMappingSchema = z.object({
  columns: z.array(importColumnSchema).min(1),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

// --- Dedupe config ----------------------------------------------------------

export const DEDUPE_ACTIONS = ['skip', 'merge-fields', 'create-anyway'] as const;
export type DedupeAction = (typeof DEDUPE_ACTIONS)[number];
export const dedupeActionSchema = z.enum(DEDUPE_ACTIONS);

export const dedupeConfigSchema = z.object({
  action: dedupeActionSchema.default('skip'),
  matchOn: z
    .object({
      email: z.boolean().default(true),
      domain: z.boolean().default(true),
      fuzzyName: z.boolean().default(true),
    })
    .default({ email: true, domain: true, fuzzyName: true }),
  /** Trigram similarity threshold (pg_trgm) for fuzzy company-name matches. */
  fuzzyNameThreshold: z.number().min(0).max(1).default(0.45),
});
export type DedupeConfig = z.infer<typeof dedupeConfigSchema>;

// --- Dispositions + plan ----------------------------------------------------

export const ROW_OUTCOMES = ['create', 'dedupe', 'error', 'empty'] as const;
export type RowOutcome = (typeof ROW_OUTCOMES)[number];

export const MATCH_TYPES = ['email', 'domain', 'fuzzy-name'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export interface RowError {
  /** Source header of the offending cell (absent for row-level errors). */
  column: string | null;
  /** Target field the cell was mapping to (absent for row-level errors). */
  target: string | null;
  code: string;
  message: string;
  value: string | null;
}

export interface PlannedLead {
  /** Assigned uuid for a create; the matched existing id for a merge. */
  id: string;
  name: string | null;
  url: string | null;
  description: string | null;
  dnc: boolean;
  statusId: string | null;
  ownerId: string | null;
  custom: Record<string, unknown>;
}

export interface PlannedContact {
  /** Pre-assigned uuid so a resumed/replayed commit never duplicates the row. */
  id: string;
  /** Resolved non-null contact name (falls back to email/phone/title). */
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  /** Email present in an active `suppressions` row (imported, never contacted). */
  suppressed: boolean;
}

/**
 * One row's decided disposition. `outcome` + `action`/`matchType` are the
 * contract's per-row disposition (create-lead / create-contact / dedupe-hit +
 * action / error); `lead`/`contact` carry the data the committer writes.
 */
export interface RowPlan {
  /** 1-based data-row number (header excluded). */
  rowIndex: number;
  outcome: RowOutcome;
  action: DedupeAction | null;
  matchType: MatchType | null;
  leadCreated: boolean;
  contactCreated: boolean;
  /** Created lead id, or the matched existing lead id; null for error/empty. */
  targetLeadId: string | null;
  lead: PlannedLead | null;
  contact: PlannedContact | null;
  errors: RowError[];
  suppressedEmails: string[];
}

export interface ImportCounts {
  totalRows: number;
  emptyRows: number;
  errorRows: number;
  leadsCreated: number;
  contactsCreated: number;
  dedupeSkipped: number;
  dedupeMerged: number;
  dedupeCreateAnyway: number;
  matchedByEmail: number;
  matchedByDomain: number;
  matchedByFuzzyName: number;
  suppressedContacts: number;
}

export interface ImportPlan {
  version: 1;
  counts: ImportCounts;
  rows: RowPlan[];
  /** Header-level notes (duplicate headers, unmapped targets). */
  warnings: string[];
}

export function emptyCounts(): ImportCounts {
  return {
    totalRows: 0,
    emptyRows: 0,
    errorRows: 0,
    leadsCreated: 0,
    contactsCreated: 0,
    dedupeSkipped: 0,
    dedupeMerged: 0,
    dedupeCreateAnyway: 0,
    matchedByEmail: 0,
    matchedByDomain: 0,
    matchedByFuzzyName: 0,
    suppressedContacts: 0,
  };
}

// --- Commit checkpoint (persisted to imports.result) ------------------------

export interface CommitCounters {
  leads: number;
  contacts: number;
  merged: number;
  activities: number;
}

export interface CommitLease {
  committerId: string;
  heartbeatAt: string;
}

export interface CommitResult {
  status: 'in_progress' | 'done' | 'failed';
  /** Index into `plan.rows` of the next row to process (checkpoint). */
  nextRowIndex: number;
  counters: CommitCounters;
  lease: CommitLease | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}
