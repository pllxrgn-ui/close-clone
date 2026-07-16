import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.ts';
import type { DoneCandidate, OpenSnapshot, ReplyRow, ReviewRow, TaskRow } from './model.ts';
import { startOfTodayMs } from './time.ts';

/**
 * Inbox loaders — the SQL that projects the three real sources into the snapshot
 * the pure model (`model.ts`) merges. This is the read-only projection C7 D-030
 * calls for; nothing here is a table. Timestamps are normalized to ISO so the
 * model's `Date.parse` math is identical to the web's (which runs on ISO).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

function iso(v: unknown): string {
  return new Date(v as string).toISOString();
}
function isoN(v: unknown): string | null {
  return v === null || v === undefined ? null : new Date(v as string).toISOString();
}
function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}
function strN(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(String(v));
}

/** Collapse a template body to a one-line preview for the review row. */
function oneLine(body: unknown): string {
  if (body === null || body === undefined) return '';
  const flat = String(body).replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

type RawRows = { rows: Record<string, unknown>[] };

/** Load open tasks (incomplete, due) with their lead name + DNC flag. */
async function loadTasks(db: Db, nowIso: string): Promise<TaskRow[]> {
  const res = (await db.execute(sql`
    SELECT t.id AS task_id, t.lead_id, l.name AS lead_name, t.title,
           t.due_at, t.completed_at, l.dnc AS lead_dnc
    FROM tasks t
    JOIN leads l ON l.id = t.lead_id AND l.deleted_at IS NULL
    WHERE t.completed_at IS NULL AND t.due_at IS NOT NULL AND t.due_at <= ${nowIso}
  `)) as RawRows;
  return res.rows.map((r) => ({
    taskId: str(r['task_id']),
    leadId: str(r['lead_id']),
    leadName: str(r['lead_name']),
    title: str(r['title']),
    dueAt: isoN(r['due_at']),
    completedAt: isoN(r['completed_at']),
    leadDnc: r['lead_dnc'] === true,
  }));
}

/**
 * Load open reply threads: matched-to-a-lead threads whose latest inbound message
 * is newer than the latest outbound (unanswered). The contact is resolved by
 * matching the inbound sender against the lead's contacts.
 */
async function loadReplies(db: Db): Promise<ReplyRow[]> {
  const res = (await db.execute(sql`
    SELECT t.id AS thread_id, t.lead_id, l.name AS lead_name, t.subject_norm,
           mi.from_addr, mi.subject AS msg_subject, mi.snippet, mi.sent_at AS received_at,
           mo.max_out AS last_contacted_at,
           ct.id AS contact_id, ct.name AS contact_name
    FROM email_threads t
    JOIN leads l ON l.id = t.lead_id AND l.deleted_at IS NULL
    JOIN LATERAL (
      SELECT m.from_addr, m.subject, m.snippet, m.sent_at
      FROM email_messages m
      WHERE m.thread_id = t.id AND m.direction = 'in'
        AND m.sent_at IS NOT NULL AND m.from_addr IS NOT NULL
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT 1
    ) mi ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(m.sent_at) AS max_out
      FROM email_messages m
      WHERE m.thread_id = t.id AND m.direction = 'out'
    ) mo ON TRUE
    LEFT JOIN LATERAL (
      SELECT c.id, c.name
      FROM contacts c
      WHERE c.lead_id = t.lead_id AND c.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(c.emails) e
          WHERE lower(e->>'email') = lower(mi.from_addr)
        )
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT 1
    ) ct ON TRUE
    WHERE t.lead_id IS NOT NULL
      AND (mo.max_out IS NULL OR mi.sent_at > mo.max_out)
  `)) as RawRows;
  return res.rows.map((r) => {
    const fromAddr = str(r['from_addr']);
    return {
      threadId: str(r['thread_id']),
      leadId: str(r['lead_id']),
      leadName: str(r['lead_name']),
      contactId: strN(r['contact_id']),
      contactName:
        r['contact_name'] !== null && r['contact_name'] !== undefined
          ? String(r['contact_name'])
          : fromAddr,
      toAddress: fromAddr,
      subject: strN(r['msg_subject']) ?? strN(r['subject_norm']),
      snippet: str(r['snippet']),
      receivedAt: iso(r['received_at']),
      lastContactedAt: isoN(r['last_contacted_at']),
    } satisfies ReplyRow;
  });
}

/** Load sequence steps AWAITING_REVIEW (email/sms), with sequence + step context. */
async function loadReviews(db: Db): Promise<ReviewRow[]> {
  const res = (await db.execute(sql`
    SELECT si.id AS intent_id, si.enrollment_id, si.channel, si.due_at, si.state,
           e.lead_id, l.name AS lead_name, c.name AS contact_name, s.name AS sequence_name,
           tpl.subject AS tpl_subject, tpl.body AS tpl_body,
           (SELECT count(*) FROM sequence_steps ss WHERE ss.sequence_id = s.id) AS step_count,
           (SELECT count(*) FROM sequence_steps ss WHERE ss.sequence_id = s.id
              AND (ss.sort_order < st.sort_order
                   OR (ss.sort_order = st.sort_order AND ss.id <= st.id))) AS step_index
    FROM send_intents si
    JOIN sequence_enrollments e ON e.id = si.enrollment_id
    JOIN sequences s ON s.id = e.sequence_id
    JOIN sequence_steps st ON st.id = si.step_id
    JOIN leads l ON l.id = e.lead_id AND l.deleted_at IS NULL
    JOIN contacts c ON c.id = e.contact_id
    LEFT JOIN templates tpl ON tpl.id = st.template_id
    WHERE si.state = 'AWAITING_REVIEW' AND si.channel IN ('email', 'sms')
  `)) as RawRows;
  return res.rows.map((r) => {
    const channel = str(r['channel']) === 'sms' ? 'sms' : 'email';
    return {
      intentId: str(r['intent_id']),
      enrollmentId: str(r['enrollment_id']),
      leadId: str(r['lead_id']),
      leadName: str(r['lead_name']),
      contactName: str(r['contact_name']),
      sequenceName: str(r['sequence_name']),
      stepIndex: num(r['step_index']),
      stepCount: num(r['step_count']),
      channel,
      subject: channel === 'email' ? strN(r['tpl_subject']) : null,
      preview: oneLine(r['tpl_body']),
      dueAt: iso(r['due_at']),
      state: str(r['state']),
    } satisfies ReviewRow;
  });
}

/** Load the open (actionable) snapshot: due tasks + unanswered replies + reviews. */
export async function loadOpenSnapshot(db: Db, nowMs: number): Promise<OpenSnapshot> {
  const nowIso = new Date(nowMs).toISOString();
  const [tasks, replies, reviews] = await Promise.all([
    loadTasks(db, nowIso),
    loadReplies(db),
    loadReviews(db),
  ]);
  return { tasks, replies, reviews };
}

/**
 * Load the "cleared today" candidates: tasks completed today, threads answered
 * today (an outbound after the last inbound), and review steps dispositioned today
 * (SENT/SKIPPED). The pure `countDoneToday` applies the exact day-window filter.
 */
export async function loadDoneCandidates(db: Db, nowMs: number): Promise<DoneCandidate[]> {
  const startIso = new Date(startOfTodayMs(nowMs)).toISOString();

  const tasksDone = (await db.execute(sql`
    SELECT t.completed_at AS at
    FROM tasks t
    WHERE t.completed_at IS NOT NULL AND t.completed_at >= ${startIso}
  `)) as RawRows;

  const threadsAnswered = (await db.execute(sql`
    SELECT mo.max_out AS at
    FROM email_threads t
    JOIN LATERAL (
      SELECT max(m.sent_at) AS max_out FROM email_messages m
      WHERE m.thread_id = t.id AND m.direction = 'out'
    ) mo ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(m.sent_at) AS max_in FROM email_messages m
      WHERE m.thread_id = t.id AND m.direction = 'in'
    ) mi ON TRUE
    WHERE t.lead_id IS NOT NULL AND mo.max_out IS NOT NULL AND mi.max_in IS NOT NULL
      AND mo.max_out > mi.max_in AND mo.max_out >= ${startIso}
  `)) as RawRows;

  const reviewsDone = (await db.execute(sql`
    SELECT (CASE WHEN si.state = 'SENT' THEN si.sent_at ELSE si.updated_at END) AS at
    FROM send_intents si
    JOIN sequence_steps st ON st.id = si.step_id
    WHERE st.requires_review = true AND si.channel IN ('email', 'sms')
      AND (
        (si.state = 'SENT' AND si.sent_at IS NOT NULL AND si.sent_at >= ${startIso})
        OR (si.state = 'SKIPPED' AND si.updated_at >= ${startIso})
      )
  `)) as RawRows;

  return [...tasksDone.rows, ...threadsAnswered.rows, ...reviewsDone.rows].map((r) => ({
    at: isoN(r['at']),
  }));
}
