import type { PgTable } from 'drizzle-orm/pg-core';

import {
  activities,
  apiTokens,
  auditLog,
  calls,
  contacts,
  customFieldDefs,
  emailAccounts,
  emailMessages,
  emailThreads,
  leads,
  leadStatuses,
  notes,
  opportunities,
  opportunityStages,
  orgSettings,
  sendIntents,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  smartViews,
  smsMessages,
  snippets,
  suppressions,
  syncEvents,
  tasks,
  templates,
  users,
  webhookDeliveries,
  webhookInbox,
  webhookSubscriptions,
} from '../../db/index.ts';

/**
 * The export manifest (Task 5g): every C1 entity present in this worktree's
 * schema, in a stable dimensions-then-facts order. Each descriptor names the
 * Drizzle table plus two policy knobs:
 *
 *   - `exclude`: Drizzle JS property names never written to the export. Two
 *     reasons appear here — GENERATED columns (`search_tsv`/`search_text`, derived
 *     and non-importable) and SECRETS. The secret exclusions are the load-bearing
 *     ones: `email_accounts.oauth_tokens` and `api_tokens.hash` must never leave
 *     the DB (build guide §5g / §1 data-ownership: the org owns its data, but
 *     credential material is not exported). Suppressions and `audit_log` ARE
 *     exported (the org owns its compliance record).
 *   - `customEntity`: when set, `custom_field_defs` rows for that entity flatten
 *     into `custom.<key>` columns appended after the base columns (leads only —
 *     it is the only C1 table with a `custom` jsonb column). The raw `custom`
 *     column is still exported, so non-catalog keys are never lost.
 *
 * `imports` (CONTRACTS v1.1.0 / migration 0010) is intentionally absent: that
 * migration is not merged into this worktree, so the table does not exist here.
 * Reported as friction — the export set tracks the schema actually present.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

export type CustomEntity = 'lead' | 'contact' | 'opportunity';

export interface ExportEntity {
  /** The Drizzle table. Its SQL name (via `getTableName`) is the file basename. */
  table: PgTable;
  /** Drizzle JS property names to omit (generated columns and secrets). */
  exclude?: readonly string[];
  /** When set, flatten `custom_field_defs` of this entity into `custom.<key>`. */
  customEntity?: CustomEntity;
}

const GENERATED = ['searchTsv', 'searchText'] as const;

export const EXPORT_ENTITIES: readonly ExportEntity[] = [
  // Dimensions.
  { table: users },
  { table: leadStatuses },
  { table: opportunityStages },
  { table: customFieldDefs },
  // Core CRM.
  { table: leads, exclude: GENERATED, customEntity: 'lead' },
  { table: contacts, exclude: GENERATED },
  { table: opportunities },
  { table: activities },
  { table: tasks },
  { table: notes },
  // Email.
  { table: emailAccounts, exclude: ['oauthTokens'] },
  { table: emailThreads },
  { table: emailMessages },
  // Templates / snippets.
  { table: templates },
  { table: snippets },
  // Sequences.
  { table: sequences },
  { table: sequenceSteps },
  { table: sequenceEnrollments },
  { table: sendIntents },
  // Compliance (the org's record — INCLUDED).
  { table: suppressions },
  // Telephony.
  { table: calls },
  { table: smsMessages },
  // Views / webhooks / tokens / audit.
  { table: smartViews },
  { table: webhookInbox },
  { table: webhookSubscriptions },
  { table: webhookDeliveries },
  { table: apiTokens, exclude: ['hash'] },
  { table: auditLog },
  { table: orgSettings },
  { table: syncEvents },
];
