import { asc, eq, sql } from 'drizzle-orm';
import { emailMessages, type Db } from '../../db/index.ts';
import { recordActivity } from '../activity/index.ts';

/**
 * Email → activity materialization (task 2c, CONTRACTS §C4).
 *
 * When a thread is matched to a lead, every message in it becomes exactly one
 * `email_received` (direction 'in') or `email_sent` (direction 'out') activity on
 * that lead's timeline, written through the sole ActivityWriter path so the C1
 * denormalized columns advance (`last_email_at`, and `last_inbound_at` /
 * `last_contacted_at`). This is the single code path used both at ingest (message
 * lands in an already-matched thread) and at human triage resolution (an ambiguous
 * thread is attached to a lead — its messages' activities are backfilled).
 *
 * Exactly-once (CONTRACTS §C4): each message's activity carries its
 * `emailMessageId`, and this function skips any message that already has one — so
 * re-ingest, re-matching, and re-resolution never double-write. Corrections are
 * therefore unnecessary here: an ambiguous message simply has no activity until a
 * lead is known, and then gets exactly one.
 *
 * Runs on the caller's transaction handle so the writes commit atomically with the
 * message/thread state that triggered them (I-SYNC).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** Whether an email activity already exists for this message (global dedupe). */
async function emailActivityExists(exec: Db, emailMessageId: string): Promise<boolean> {
  const result = await exec.execute(sql`
    SELECT 1
    FROM activities
    WHERE type IN ('email_received', 'email_sent')
      AND payload->>'emailMessageId' = ${emailMessageId}
    LIMIT 1
  `);
  return (result as { rows: unknown[] }).rows.length > 0;
}

/**
 * Ensure every message in `threadId` has its `email_received`/`email_sent`
 * activity on `leadId`. Returns the number of activities newly written (0 when all
 * already existed — the idempotent re-run case).
 */
export async function materializeThreadActivities(
  exec: Db,
  threadId: string,
  leadId: string,
): Promise<number> {
  const msgs = await exec
    .select({
      id: emailMessages.id,
      direction: emailMessages.direction,
      subject: emailMessages.subject,
      sentAt: emailMessages.sentAt,
    })
    .from(emailMessages)
    .where(eq(emailMessages.threadId, threadId))
    .orderBy(asc(emailMessages.sentAt), asc(emailMessages.rfcMessageId));

  let written = 0;
  for (const m of msgs) {
    if (await emailActivityExists(exec, m.id)) continue;
    const type = m.direction === 'in' ? 'email_received' : 'email_sent';
    const payload: Record<string, unknown> = { emailMessageId: m.id, threadId };
    if (m.subject !== null) payload['subject'] = m.subject;
    await recordActivity(exec, {
      leadId,
      type,
      occurredAt: m.sentAt ?? new Date().toISOString(),
      payload,
    });
    written += 1;
  }
  return written;
}
