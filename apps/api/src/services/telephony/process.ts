import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { callStatusValues, type ActivityType } from '@switchboard/shared';
import type { TelephonyProvider } from '@switchboard/shared/providers';
import { calls, smsMessages, webhookInbox, type Db } from '../../db/index.ts';
import { recordActivity } from '../activity/index.ts';
import { matchOptOutKeyword } from '../../providers/telephony/opt-out.ts';
import { resolveContactByPhone, phoneMatchKey } from './phone.ts';
import { addPhoneSuppression } from './suppression.ts';
import type { TwilioChannel } from './ingress.ts';

/**
 * Twilio inbox worker (ARCHITECTURE §5 persist-then-process; CONTRACTS §C4 call /
 * sms events, §C6 I-QUIET). Consumes `webhook_inbox` rows the ingress stored and
 * maps the Twilio lifecycle to EXACTLY-ONCE C4 timeline events via the sole
 * `ActivityWriter` path.
 *
 * Exactly-once is structural, on two levels:
 *   1. Each inbox row is CLAIMED atomically (`UPDATE … processed_at=now() WHERE
 *      processed_at IS NULL RETURNING`) — a second processor gets 0 rows and stops,
 *      and the claim + all writes commit together, so a crash rolls the claim back
 *      for a clean retry.
 *   2. Each lifecycle callback is a UNIQUE inbox event (see `ingress.parseTwilioWebhook`),
 *      and the terminal call-status callback is the ONE that emits a call activity —
 *      guarded additionally by an existence check so a duplicate terminal (different
 *      SequenceNumber) still yields a single timeline row.
 *
 * The one side effect outside the DB is the §I-QUIET opt-out confirmation SMS,
 * issued AFTER commit (like `dispatch.ts` issues the provider send outside the
 * claim txn) with a per-message idempotency key.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const DEFAULT_OPT_OUT_CONFIRMATION =
  'You are unsubscribed and will not receive further messages. Reply HELP for help.';

const TERMINAL_CALL_ACTIVITIES: readonly ActivityType[] = [
  'call_logged',
  'call_missed',
  'voicemail_received',
];

type CallStatusValue = (typeof callStatusValues)[number];

export interface TelephonyProcessDeps {
  db: Db;
  /** Used only for the §I-QUIET opt-out confirmation send (post-commit). */
  provider: Pick<TelephonyProvider, 'sendSms'>;
  /** Body of the opt-out confirmation SMS. */
  optOutConfirmationBody?: string;
}

export interface ProcessResult {
  alreadyProcessed: boolean;
  channel: TwilioChannel | null;
  /** The C4 activity type emitted, if any. */
  activity: ActivityType | null;
  /** Soft-failure note recorded on the inbox row (e.g. unknown number). */
  error: string | null;
  confirmationSent: boolean;
}

const rawInboxSchema = z.object({
  channel: z.enum(['voice', 'sms', 'status']),
  params: z.record(z.string()),
  receivedAt: z.string(),
});

interface OptOutConfirmation {
  from: string;
  to: string;
  body: string;
  idempotencyKey: string;
}

interface ChannelOutcome {
  activity: ActivityType | null;
  error: string | null;
  confirmation: OptOutConfirmation | null;
}

/**
 * Process one Twilio `webhook_inbox` row idempotently. Claims the row, maps it to
 * the timeline, and (for an opt-out) returns the confirmation to send post-commit.
 */
export async function processTwilioInboxRow(
  deps: TelephonyProcessDeps,
  inboxId: string,
): Promise<ProcessResult> {
  const outcome = await deps.db.transaction(
    async (
      txRaw,
    ): Promise<
      | { alreadyProcessed: true }
      | ({ alreadyProcessed: false; channel: TwilioChannel } & ChannelOutcome)
    > => {
      const tx = txRaw as Db;
      // Atomic claim — a second processor gets 0 rows and bails.
      const claimed = await tx
        .update(webhookInbox)
        .set({ processedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(webhookInbox.id, inboxId),
            eq(webhookInbox.provider, 'twilio'),
            isNull(webhookInbox.processedAt),
          ),
        )
        .returning({ raw: webhookInbox.raw });
      const claim = claimed[0];
      if (claim === undefined) return { alreadyProcessed: true };

      const decoded = rawInboxSchema.parse(claim.raw);
      let result: ChannelOutcome;
      if (decoded.channel === 'voice') {
        // The TwiML routing decision is served synchronously by the route; the
        // stored voice request is retained for audit/replay only.
        result = { activity: null, error: null, confirmation: null };
      } else if (decoded.channel === 'status') {
        result = await processStatus(tx, decoded.params, decoded.receivedAt);
      } else {
        result = await processSms(tx, deps, decoded.params, decoded.receivedAt);
      }

      if (result.error !== null) {
        await tx
          .update(webhookInbox)
          .set({ error: result.error, updatedAt: sql`now()` })
          .where(eq(webhookInbox.id, inboxId));
      }
      return { alreadyProcessed: false, channel: decoded.channel, ...result };
    },
  );

  if (outcome.alreadyProcessed) {
    return {
      alreadyProcessed: true,
      channel: null,
      activity: null,
      error: null,
      confirmationSent: false,
    };
  }

  // Post-commit: the opt-out confirmation SMS (I-QUIET "confirm once"). Best-effort
  // — the suppression + sms_opt_out are already committed; a failed courtesy send
  // never un-suppresses. The per-message idempotency key makes a retry safe.
  let confirmationSent = false;
  if (outcome.confirmation !== null) {
    try {
      await deps.provider.sendSms(
        outcome.confirmation.from,
        outcome.confirmation.to,
        outcome.confirmation.body,
        outcome.confirmation.idempotencyKey,
      );
      confirmationSent = true;
    } catch {
      confirmationSent = false;
    }
  }

  return {
    alreadyProcessed: false,
    channel: outcome.channel,
    activity: outcome.activity,
    error: outcome.error,
    confirmationSent,
  };
}

/** Process every unprocessed Twilio inbox row (sweeper; also drives tests). */
export async function processPendingTwilioWebhooks(
  deps: TelephonyProcessDeps,
): Promise<ProcessResult[]> {
  const pending = await deps.db
    .select({ id: webhookInbox.id })
    .from(webhookInbox)
    .where(and(eq(webhookInbox.provider, 'twilio'), isNull(webhookInbox.processedAt)))
    .orderBy(asc(webhookInbox.receivedAt), asc(webhookInbox.id));
  const results: ProcessResult[] = [];
  for (const row of pending) {
    results.push(await processTwilioInboxRow(deps, row.id));
  }
  return results;
}

// --- Status (voice + recording) callbacks ----------------------------------

interface CallRowLite {
  id: string;
  leadId: string;
  contactId: string | null;
  userId: string | null;
}

async function processStatus(
  tx: Db,
  params: Record<string, string>,
  receivedAt: string,
): Promise<ChannelOutcome> {
  const callSid = params['CallSid'];
  if (callSid === undefined || callSid.length === 0) return noop('missing_call_sid');
  const direction = twilioDirection(params);
  const occurredAt = parseOccurredAt(params, receivedAt);

  const call = await ensureCallRow(tx, callSid, params, direction, occurredAt);
  if ('error' in call) return noop(call.error);

  const recordingStatus = params['RecordingStatus'];
  const recordingUrl = params['RecordingUrl'];
  if (recordingStatus !== undefined && recordingStatus.length > 0) {
    // A recording callback: a recording only exists because consent was announced
    // (§I-REC, enforced at the adapter line). Record the consent marker once, and
    // attach the ref when the recording completes.
    await ensureConsentPlayed(tx, call, occurredAt);
    if (recordingStatus === 'completed' && recordingUrl !== undefined && recordingUrl.length > 0) {
      await tx
        .update(calls)
        .set({ recordingRef: recordingUrl, updatedAt: sql`now()` })
        .where(eq(calls.id, call.id));
    }
    return { activity: null, error: null, confirmation: null };
  }

  const callStatus = params['CallStatus'];
  if (callStatus === undefined || callStatus.length === 0) return noop('missing_call_status');

  const terminal = classifyTerminal(params, direction);
  if (terminal === null) {
    // Intermediate (queued/ringing/in-progress): advance status only.
    await tx
      .update(calls)
      .set({ status: mapCallStatus(callStatus), updatedAt: sql`now()` })
      .where(eq(calls.id, call.id));
    return { activity: null, error: null, confirmation: null };
  }

  // Terminal: finalise the call row, then emit the ONE call activity (guarded).
  await tx
    .update(calls)
    .set({
      status: terminal.callStatus,
      endedAt: occurredAt,
      ...(terminal.durationS !== undefined ? { durationS: terminal.durationS } : {}),
      ...(terminal.recordingRef !== undefined ? { recordingRef: terminal.recordingRef } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(calls.id, call.id));

  if (await hasTerminalCallActivity(tx, call)) {
    return { activity: null, error: null, confirmation: null };
  }

  const payload: Record<string, unknown> = { callId: call.id, direction, channel: 'voice' };
  if (terminal.durationS !== undefined) payload['durationS'] = terminal.durationS;
  if (terminal.recordingRef !== undefined) payload['recordingRef'] = terminal.recordingRef;
  await recordActivity(tx, {
    leadId: call.leadId,
    contactId: call.contactId,
    ...(call.userId !== null ? { userId: call.userId } : {}),
    type: terminal.activity,
    occurredAt,
    payload,
  });
  return { activity: terminal.activity, error: null, confirmation: null };
}

interface TerminalClassification {
  activity: ActivityType;
  callStatus: CallStatusValue;
  durationS?: number;
  recordingRef?: string;
}

/**
 * Map a terminal Twilio call-status callback to its C4 activity + the `calls.status`
 * it lands on. Returns null for a non-terminal (intermediate) status.
 */
export function classifyTerminal(
  params: Record<string, string>,
  direction: 'inbound' | 'outbound',
): TerminalClassification | null {
  const status = params['CallStatus'] ?? '';
  const answeredBy = params['AnsweredBy'] ?? '';
  const recordingUrl = params['RecordingUrl'];
  const durationRaw = Number.parseInt(params['CallDuration'] ?? '', 10);
  const durationS = Number.isNaN(durationRaw) ? undefined : durationRaw;
  const isMachineVoicemail =
    answeredBy.startsWith('machine') && recordingUrl !== undefined && recordingUrl.length > 0;

  if (status === 'completed') {
    if (direction === 'inbound' && isMachineVoicemail) {
      return {
        activity: 'voicemail_received',
        callStatus: 'voicemail',
        recordingRef: recordingUrl,
      };
    }
    if (durationS !== undefined && durationS > 0) {
      return { activity: 'call_logged', callStatus: 'completed', durationS };
    }
    // Completed but never answered (no talk time, no voicemail) → missed.
    return { activity: 'call_missed', callStatus: 'missed' };
  }
  if (status === 'no-answer' || status === 'busy' || status === 'canceled') {
    return { activity: 'call_missed', callStatus: 'missed' };
  }
  if (status === 'failed') {
    return { activity: 'call_missed', callStatus: 'failed' };
  }
  return null;
}

// --- Inbound SMS ------------------------------------------------------------

async function processSms(
  tx: Db,
  deps: TelephonyProcessDeps,
  params: Record<string, string>,
  receivedAt: string,
): Promise<ChannelOutcome> {
  const messageSid = params['MessageSid'] ?? params['SmsSid'] ?? params['SmsMessageSid'];
  const from = params['From'];
  const to = params['To'];
  const body = params['Body'] ?? '';
  if (messageSid === undefined || from === undefined || to === undefined) {
    return noop('malformed_sms');
  }

  const match = await resolveContactByPhone(tx, from);
  if (match === null) return noop('no_contact_for_number');

  // Persist the inbound message (dedupe backstop on provider_sid).
  const smsRows = await tx
    .insert(smsMessages)
    .values({
      leadId: match.leadId,
      contactId: match.contactId,
      direction: 'inbound',
      fromNumber: from,
      toNumber: to,
      body,
      providerSid: messageSid,
      status: 'received',
      sentAt: receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: smsMessages.id });
  const smsId = smsRows[0]?.id ?? (await loadSmsIdBySid(tx, messageSid));

  const keyword = matchOptOutKeyword(body);
  if (keyword !== null) {
    // I-QUIET: suppress the number globally, emit sms_opt_out, confirm once.
    await addPhoneSuppression(tx, {
      key: phoneMatchKey(from),
      source: 'stop_keyword',
      reason: `sms ${keyword}`,
    });
    await recordActivity(tx, {
      leadId: match.leadId,
      contactId: match.contactId,
      type: 'sms_opt_out',
      occurredAt: receivedAt,
      payload: {
        number: from,
        keyword,
        channel: 'sms',
        ...(smsId !== null ? { smsMessageId: smsId } : {}),
      },
    });
    return {
      activity: 'sms_opt_out',
      error: null,
      confirmation: {
        from: to,
        to: from,
        body: deps.optOutConfirmationBody ?? DEFAULT_OPT_OUT_CONFIRMATION,
        idempotencyKey: `optout-confirm:${messageSid}`,
      },
    };
  }

  await recordActivity(tx, {
    leadId: match.leadId,
    contactId: match.contactId,
    type: 'sms_received',
    occurredAt: receivedAt,
    payload: { body, channel: 'sms', ...(smsId !== null ? { smsMessageId: smsId } : {}) },
  });
  return { activity: 'sms_received', error: null, confirmation: null };
}

async function loadSmsIdBySid(tx: Db, providerSid: string): Promise<string | null> {
  const rows = await tx
    .select({ id: smsMessages.id })
    .from(smsMessages)
    .where(eq(smsMessages.providerSid, providerSid))
    .limit(1);
  return rows[0]?.id ?? null;
}

// --- Helpers ----------------------------------------------------------------

function noop(error: string): ChannelOutcome {
  return { activity: null, error, confirmation: null };
}

function twilioDirection(params: Record<string, string>): 'inbound' | 'outbound' {
  return (params['Direction'] ?? '').startsWith('inbound') ? 'inbound' : 'outbound';
}

function parseOccurredAt(params: Record<string, string>, receivedAt: string): string {
  const ts = params['Timestamp'];
  if (ts !== undefined && ts.length > 0) {
    const parsed = new Date(ts);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return receivedAt;
}

function mapCallStatus(twilioStatus: string): CallStatusValue {
  switch (twilioStatus) {
    case 'ringing':
      return 'ringing';
    case 'in-progress':
      return 'answered';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'no-answer':
    case 'busy':
    case 'canceled':
      return 'missed';
    default:
      return 'queued';
  }
}

async function ensureCallRow(
  tx: Db,
  callSid: string,
  params: Record<string, string>,
  direction: 'inbound' | 'outbound',
  occurredAt: string,
): Promise<CallRowLite | { error: string }> {
  const existing = await loadCall(tx, callSid);
  if (existing !== null) return existing;

  const external = direction === 'inbound' ? params['From'] : params['To'];
  if (external === undefined || external.length === 0) return { error: 'missing_external_number' };
  const match = await resolveContactByPhone(tx, external);
  if (match === null) return { error: 'no_contact_for_number' };

  await tx
    .insert(calls)
    .values({
      leadId: match.leadId,
      contactId: match.contactId,
      direction,
      twilioSid: callSid,
      status: mapCallStatus(params['CallStatus'] ?? 'queued'),
      startedAt: occurredAt,
    })
    .onConflictDoNothing();
  const row = await loadCall(tx, callSid);
  if (row === null) return { error: 'call_row_missing_after_insert' };
  return row;
}

async function loadCall(tx: Db, callSid: string): Promise<CallRowLite | null> {
  const rows = await tx
    .select({
      id: calls.id,
      leadId: calls.leadId,
      contactId: calls.contactId,
      userId: calls.userId,
    })
    .from(calls)
    .where(eq(calls.twilioSid, callSid))
    .limit(1);
  return rows[0] ?? null;
}

async function ensureConsentPlayed(tx: Db, call: CallRowLite, occurredAt: string): Promise<void> {
  const exists = await tx.execute(sql`
    SELECT 1 FROM activities
    WHERE lead_id = ${call.leadId}
      AND type = 'recording_consent_played'
      AND payload->>'callId' = ${call.id}
    LIMIT 1
  `);
  if ((exists as { rows: unknown[] }).rows.length > 0) return;
  await recordActivity(tx, {
    leadId: call.leadId,
    contactId: call.contactId,
    ...(call.userId !== null ? { userId: call.userId } : {}),
    type: 'recording_consent_played',
    occurredAt,
    payload: { callId: call.id, channel: 'voice' },
  });
}

async function hasTerminalCallActivity(tx: Db, call: CallRowLite): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT 1 FROM activities
    WHERE lead_id = ${call.leadId}
      AND type IN ('call_logged', 'call_missed', 'voicemail_received')
      AND payload->>'callId' = ${call.id}
    LIMIT 1
  `);
  return (result as { rows: unknown[] }).rows.length > 0;
}

export { TERMINAL_CALL_ACTIVITIES };
