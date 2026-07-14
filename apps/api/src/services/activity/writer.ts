import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { parseActivityPayload, type ActivityType } from '@switchboard/shared';
import { activities, leads, tasks, type ActivityRow, type Db } from '../../db/index.ts';

/**
 * ActivityWriter — the SOLE write path to the append-only `activities` spine
 * (CONTRACTS §C1/§C4). `record()`:
 *   1. validates the payload against the C4 zod schema for its type (bad
 *      payload → thrown `ZodError`, nothing written);
 *   2. inserts the event append-only; and
 *   3. IN THE SAME TRANSACTION updates the C1 denormalized `leads` columns per
 *      the mapping below.
 *
 * No other module inserts into `activities`; the fixture loader is a bulk seed
 * utility (out-of-band, like a migration), not an application write path.
 *
 * This file is import-safe for direct `node` execution: no enums / namespaces /
 * parameter properties (host type-stripping constraint).
 */

// --- Errors ----------------------------------------------------------------

export class ActivityWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityWriterError';
  }
}

/** Thrown when the target lead is missing or soft-deleted; rolls the txn back. */
export class LeadNotFoundError extends ActivityWriterError {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`lead ${leadId} not found or soft-deleted`);
    this.name = 'LeadNotFoundError';
    this.leadId = leadId;
  }
}

// --- Denormalization mapping (CONTRACTS §C4) -------------------------------

/** Denormalized last-touch columns on `leads` maintained by the writer. */
type LeadTouchColumn =
  | 'lastContactedAt'
  | 'lastInboundAt'
  | 'lastCallAt'
  | 'lastEmailAt'
  | 'lastSmsAt';

/**
 * Per-event last-touch mapping. Kept byte-consistent with the fixture
 * generator's denorm derivation (`fixtures/src/generate.ts`) so writer-produced
 * and fixture-seeded leads agree:
 *   outbound contact → last_contacted_at; inbound reply → last_inbound_at;
 *   per-channel → last_call_at / last_email_at / last_sms_at.
 * Columns advance monotonically (`greatest`), so out-of-order/backfilled events
 * never regress a newer touch.
 */
const LAST_TOUCH_MAP: Partial<Record<ActivityType, readonly LeadTouchColumn[]>> = {
  call_logged: ['lastCallAt', 'lastContactedAt'],
  call_missed: ['lastCallAt'],
  voicemail_received: ['lastCallAt'],
  email_sent: ['lastEmailAt', 'lastContactedAt'],
  email_received: ['lastEmailAt', 'lastInboundAt'],
  email_bounced: ['lastEmailAt'],
  sms_sent: ['lastSmsAt', 'lastContactedAt'],
  sms_received: ['lastSmsAt', 'lastInboundAt'],
  sequence_step_sent: ['lastContactedAt'],
};

/** Events that force a recompute of `next_task_due_at` from open tasks. */
const TASK_RECOMPUTE_TYPES: ReadonlySet<ActivityType> = new Set<ActivityType>([
  'task_created',
  'task_completed',
]);

// --- Input -----------------------------------------------------------------

export interface RecordActivityInput {
  leadId: string;
  contactId?: string | null;
  userId?: string | null;
  type: ActivityType;
  /** Provider time where available, ingest time otherwise (CONTRACTS §C4). */
  occurredAt: Date | string;
  payload?: unknown;
}

function toIso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

/** Build the `leads` SET clause for this event's denorm mapping. */
function buildDenormSet(
  type: ActivityType,
  occurredIso: string,
  leadId: string,
): Record<string, SQL> {
  const touch = LAST_TOUCH_MAP[type] ?? [];
  const has = (col: LeadTouchColumn): boolean => touch.includes(col);
  const advance = (col: SQL): SQL => sql`greatest(${col}, ${occurredIso}::timestamptz)`;

  const set: Record<string, SQL> = { updatedAt: sql`now()` };
  if (has('lastContactedAt')) set.lastContactedAt = advance(sql`${leads.lastContactedAt}`);
  if (has('lastInboundAt')) set.lastInboundAt = advance(sql`${leads.lastInboundAt}`);
  if (has('lastCallAt')) set.lastCallAt = advance(sql`${leads.lastCallAt}`);
  if (has('lastEmailAt')) set.lastEmailAt = advance(sql`${leads.lastEmailAt}`);
  if (has('lastSmsAt')) set.lastSmsAt = advance(sql`${leads.lastSmsAt}`);
  if (TASK_RECOMPUTE_TYPES.has(type)) {
    set.nextTaskDueAt = sql`(select min(${tasks.dueAt}) from ${tasks} where ${tasks.leadId} = ${leadId} and ${tasks.completedAt} is null)`;
  }
  return set;
}

/**
 * Record one activity. Append + denorm update are atomic: any failure (bad
 * payload, missing/deleted lead) leaves both the spine and the denorm columns
 * untouched.
 */
export async function recordActivity(db: Db, input: RecordActivityInput): Promise<ActivityRow> {
  // Validate BEFORE opening the transaction — bad payloads never touch the DB.
  const payload = parseActivityPayload(input.type, input.payload ?? {}) as Record<string, unknown>;
  const occurredIso = toIso(input.occurredAt);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(activities)
      .values({
        leadId: input.leadId,
        contactId: input.contactId ?? null,
        userId: input.userId ?? null,
        type: input.type,
        occurredAt: occurredIso,
        payload,
      })
      .returning();
    if (!row) throw new ActivityWriterError('activity insert returned no row');

    const set = buildDenormSet(input.type, occurredIso, input.leadId);
    const updated = await tx
      .update(leads)
      .set(set)
      .where(and(eq(leads.id, input.leadId), isNull(leads.deletedAt)))
      .returning({ id: leads.id });
    // 0 rows → lead absent or soft-deleted: refuse and roll the append back.
    if (updated.length === 0) throw new LeadNotFoundError(input.leadId);

    return row;
  });
}

/** Ergonomic wrapper binding {@link recordActivity} to a db handle. */
export class ActivityWriter {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  record(input: RecordActivityInput): Promise<ActivityRow> {
    return recordActivity(this.db, input);
  }
}
