import { sql } from 'drizzle-orm';
import { suppressions, type Db } from '../../db/index.ts';

/**
 * Phone-suppression primitives (CONTRACTS §C6 I-QUIET / I-DNC). Mirrors the email
 * suppression module (`services/sequences/suppression.ts`) for the `phone` kind: a
 * suppression is GLOBAL by `(kind, value)` and an ACTIVE one (`released_at IS NULL`)
 * blocks every SMS/dial path. Release is admin-only + audited (handled elsewhere);
 * this module only adds and probes.
 *
 * The value stored is the trailing-10-digit key (see `phone.ts`) so a STOP from
 * `+13055550147` suppresses `(305) 555-0147` too — probing uses the same key, so
 * the check is formatting-insensitive.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type PhoneSuppressionSource = 'stop_keyword' | 'manual' | 'import';

/** True iff `key` (a trailing-10-digit phone key) has an ACTIVE phone suppression. */
export async function isPhoneSuppressed(exec: Db, key: string): Promise<boolean> {
  if (key === '') return false;
  const result = await exec.execute(sql`
    SELECT 1
    FROM suppressions
    WHERE kind = 'phone'
      AND released_at IS NULL
      AND value = ${key}
    LIMIT 1
  `);
  return (result as { rows: unknown[] }).rows.length > 0;
}

export interface AddPhoneSuppressionInput {
  /** Trailing-10-digit phone key (see `phoneMatchKey`). */
  key: string;
  source: PhoneSuppressionSource;
  reason?: string;
  createdBy?: string;
}

export interface AddPhoneSuppressionResult {
  suppressionId: string;
  /** True iff this call created (or re-activated) the suppression. */
  created: boolean;
}

/**
 * Add (or re-activate) a global phone suppression. Idempotent on `(kind, value)`:
 * a duplicate active suppression is a no-op; a previously RELEASED row is
 * re-suppressed (a fresh STOP always wins over a prior release). Runs on the
 * caller's executor so it composes inside a processing transaction.
 */
export async function addPhoneSuppression(
  exec: Db,
  input: AddPhoneSuppressionInput,
): Promise<AddPhoneSuppressionResult> {
  const existing = await exec.execute(sql`
    SELECT id, released_at FROM suppressions
    WHERE kind = 'phone' AND value = ${input.key}
    LIMIT 1
  `);
  const rows = (existing as { rows: Record<string, unknown>[] }).rows;
  const prior = rows[0];
  if (prior !== undefined) {
    const wasReleased = prior['released_at'] !== null;
    if (wasReleased) {
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
      kind: 'phone',
      value: input.key,
      source: input.source,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    })
    .returning({ id: suppressions.id });
  return { suppressionId: inserted[0]!.id, created: true };
}
