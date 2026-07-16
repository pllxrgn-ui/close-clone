/*
 * Admin-feature local REST DTOs (CONTRACTS §C7 `admin/*`, `templates`, `snippets`,
 * `sequences`, plus the selection-bulk request/response shapes). Domain entity
 * shapes (User, Template, Snippet, OrgSettings, CustomFieldDef, Lead …) come from
 * @switchboard/shared and are never redeclared here — only the request/response
 * envelopes the mock surface and the real API exchange live in this file.
 */
import { customFieldTypeValues } from '@switchboard/shared';

/**
 * Custom-field types per CONTRACTS §C1 (`custom_field_defs.type`) — the five
 * domain values, NOT the DSL `FieldType` (which also carries `bool`).
 */
export type CustomFieldType = (typeof customFieldTypeValues)[number];

/**
 * A custom-field definition row as returned by `GET /admin/custom-fields`.
 * Structurally the shape the Smart View builder already consumes
 * (view-builder's `AdminCustomField`) so either feature's handler can serve it.
 */
export interface CustomFieldRow {
  readonly id: string;
  readonly entity: 'lead' | 'contact' | 'opportunity';
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly options: readonly string[] | null;
  readonly required: boolean;
}

/** Body for `POST /admin/custom-fields` (create-field form). */
export interface CreateCustomFieldInput {
  entity: 'lead' | 'contact' | 'opportunity';
  key: string;
  label: string;
  type: CustomFieldType;
  options?: readonly string[];
  required?: boolean;
}

/**
 * A sequence plus its live active-enrollment count. `GET /sequences` returns the
 * domain `Sequence` shape augmented with `activeEnrollments`; the real API derives
 * the count from `sequence_enrollments` (C1), the mock keeps it on the row so the
 * enroll action can tick it visibly.
 */
export interface SequenceWithCount {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'archived';
  /** Mutable so the mock enroll handler can tick it (the real API derives it). */
  activeEnrollments: number;
}

/** Body for `POST /sequences/:id/enroll` (bulk enroll over an explicit selection). */
export interface EnrollRequest {
  leadIds: string[];
}

/**
 * Result of a bulk enroll. Leads that are DNC are never enrolled (I-DNC): the
 * count split makes the compliance rail visible ("10 enrolled · 2 skipped (DNC)").
 */
export interface EnrollResult {
  sequenceId: string;
  enrolled: number;
  skipped: number;
  /** Present when `skipped > 0`; the only skip cause the mock models. */
  skipReason?: 'dnc';
  /** The sequence's new active-enrollment total after this enroll. */
  activeEnrollments: number;
}

/** The reasons the Set-DNC dialog offers (audit rationale, C1 audit_log.reason). */
export const DNC_REASONS = [
  'Requested by contact',
  'Unsubscribed',
  'Bounced / invalid',
  'Legal / compliance hold',
  'Competitor',
  'Other',
] as const;
export type DncReason = (typeof DNC_REASONS)[number];
