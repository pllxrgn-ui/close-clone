import { sql } from 'drizzle-orm';
import { suppressions, type Db } from '../../db/index.ts';

/**
 * Suppression primitives (CONTRACTS §C6 I-SEND-3 / I-SEND-5). A suppression is
 * GLOBAL by `(kind, value)`; an ACTIVE one (`released_at IS NULL`) blocks every
 * send/dial path. Release is admin-only + audited (handled elsewhere) — this
 * module only adds and probes.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type SuppressionSource = 'unsubscribe' | 'bounce' | 'stop_keyword' | 'manual' | 'import';

/** True iff `email` has an ACTIVE email suppression (probe inside the send txn). */
export async function isEmailSuppressed(exec: Db, email: string): Promise<boolean> {
  const result = await exec.execute(sql`
    SELECT 1
    FROM suppressions
    WHERE kind = 'email'
      AND released_at IS NULL
      AND value = ${email}::citext
    LIMIT 1
  `);
  return (result as { rows: unknown[] }).rows.length > 0;
}

export interface AddSuppressionInput {
  value: string;
  source: SuppressionSource;
  reason?: string;
  createdBy?: string;
}

export interface AddSuppressionResult {
  suppressionId: string;
  /** True iff this call created (or re-activated) the suppression. */
  created: boolean;
}

/**
 * Add (or re-activate) a global email suppression. Idempotent on `(kind, value)`:
 * a duplicate active suppression is a no-op; a previously RELEASED row is
 * re-suppressed (unsubscribe/bounce always wins over a prior release). Runs on the
 * caller's executor.
 */
export async function addEmailSuppression(
  exec: Db,
  input: AddSuppressionInput,
): Promise<AddSuppressionResult> {
  const existing = await exec.execute(sql`
    SELECT id, released_at FROM suppressions
    WHERE kind = 'email' AND value = ${input.value}::citext
    LIMIT 1
  `);
  const rows = (existing as { rows: Record<string, unknown>[] }).rows;
  const prior = rows[0];
  if (prior !== undefined) {
    const wasReleased = prior['released_at'] !== null;
    if (wasReleased) {
      // Re-suppress a released value (clear the release audit fields).
      await exec
        .update(suppressions)
        .set({
          releasedAt: null,
          releasedBy: null,
          releaseReason: null,
          source: input.source,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          updatedAt: sql`now()`,
        })
        .where(sql`${suppressions.id} = ${String(prior['id'])}::uuid`);
    }
    return { suppressionId: String(prior['id']), created: wasReleased };
  }

  const inserted = await exec
    .insert(suppressions)
    .values({
      kind: 'email',
      value: input.value,
      source: input.source,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    })
    .returning({ id: suppressions.id });
  return { suppressionId: inserted[0]!.id, created: true };
}
