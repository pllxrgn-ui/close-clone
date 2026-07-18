/*
 * Client-side mirror of the import engine's public contract shapes
 * (apps/api/src/services/imports/types.ts + routes/imports.ts). The engine noted
 * these live outside @switchboard/shared only because Task 4f's allowlist
 * excluded the shared package ("hoist at merge"); until that hoist lands, the web
 * surface carries its own copies so the wizard, the api-client, and the MSW mock
 * all speak one shape — byte-identical to what the real POST /imports/:id/dry-run
 * and /commit return, so MSW is a drop-in and real mode works unchanged.
 */

// ── Column mapping targets ──────────────────────────────────────────────────
export const LEAD_TARGET_FIELDS = ['name', 'url', 'description', 'dnc', 'status', 'owner'] as const;
export const CONTACT_TARGET_FIELDS = ['name', 'title', 'email', 'phone'] as const;
export type LeadTargetField = (typeof LEAD_TARGET_FIELDS)[number];
export type ContactTargetField = (typeof CONTACT_TARGET_FIELDS)[number];

export type MappingTarget =
  | { kind: 'ignore' }
  | { kind: 'lead'; field: LeadTargetField }
  | { kind: 'contact'; field: ContactTargetField }
  | { kind: 'custom'; key: string };

/** One header → target assignment (target is the serialized string form). */
export interface ImportColumn {
  source: string;
  target: string;
}
export interface ImportMapping {
  columns: ImportColumn[];
}

// ── Dedupe config ───────────────────────────────────────────────────────────
export const DEDUPE_ACTIONS = ['skip', 'merge-fields', 'create-anyway'] as const;
export type DedupeAction = (typeof DEDUPE_ACTIONS)[number];

export interface DedupeMatchOn {
  email: boolean;
  domain: boolean;
  fuzzyName: boolean;
}
export interface DedupeConfig {
  action: DedupeAction;
  matchOn: DedupeMatchOn;
  /** Trigram similarity threshold (pg_trgm) for fuzzy company-name matches. */
  fuzzyNameThreshold: number;
}

export function defaultDedupeConfig(): DedupeConfig {
  return {
    action: 'skip',
    matchOn: { email: true, domain: true, fuzzyName: true },
    fuzzyNameThreshold: 0.45,
  };
}

// ── Dispositions + plan ─────────────────────────────────────────────────────
export const ROW_OUTCOMES = ['create', 'dedupe', 'error', 'empty'] as const;
export type RowOutcome = (typeof ROW_OUTCOMES)[number];

export const MATCH_TYPES = ['email', 'domain', 'fuzzy-name'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export interface RowError {
  column: string | null;
  target: string | null;
  code: string;
  message: string;
  value: string | null;
}

export interface PlannedLead {
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
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  suppressed: boolean;
}

export interface RowPlan {
  rowIndex: number;
  outcome: RowOutcome;
  action: DedupeAction | null;
  matchType: MatchType | null;
  leadCreated: boolean;
  contactCreated: boolean;
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

// ── REST envelopes (routes/imports.ts) ──────────────────────────────────────

/** 201 body of `POST /imports` (internal fileRef/blobs omitted). */
export interface ImportResource {
  id: string;
  filename: string;
  status: string;
  rowCount: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Body of `POST /imports/:id/dry-run`. Note the key is `dedupeConfig`. */
export interface DryRunRequest {
  mapping: ImportMapping;
  dedupeConfig: DedupeConfig;
}

/** Response of `POST /imports/:id/dry-run` — the plan plus the import id. */
export interface DryRunResponse extends ImportPlan {
  importId: string;
}

export interface CommitCounters {
  leads: number;
  contacts: number;
  merged: number;
  activities: number;
}

/** Response of `POST /imports/:id/commit`. */
export interface CommitResponse {
  importId: string;
  status: 'committed' | 'stopped';
  resumed: boolean;
  counters: CommitCounters;
  nextRowIndex: number;
}
