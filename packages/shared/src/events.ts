import { z } from 'zod';

/**
 * Activity event taxonomy (CONTRACTS §C4). The `activities` table is the
 * append-only spine; each type carries a zod-typed payload validated by the
 * event writer before insert. Payloads are deliberately permissive on optional
 * provider metadata (`.passthrough()` keeps extra keys) but strict on the fields
 * the denormalization mapping and timeline rendering depend on.
 *
 * `occurred_at` is provider time where available, ingest time otherwise; the
 * ordering key is `(occurred_at, id)` (CONTRACTS §C4). The writer updates the C1
 * denormalized `leads` columns in the same transaction as the insert.
 */

export const ACTIVITY_TYPES = [
  'call_logged',
  'call_missed',
  'voicemail_received',
  'email_sent',
  'email_received',
  'email_bounced',
  'sms_sent',
  'sms_received',
  'sms_opt_out',
  'note_added',
  'task_created',
  'task_completed',
  'field_changed',
  'status_changed',
  'opportunity_created',
  'opportunity_stage_changed',
  'opportunity_closed',
  'sequence_enrolled',
  'sequence_step_sent',
  'sequence_paused',
  'sequence_finished',
  'unsubscribed',
  'suppression_added',
  'suppression_released',
  'dnc_set',
  'dnc_cleared',
  'lead_created',
  'lead_merged',
  'import_created',
  'activity_correction',
  'recording_consent_played',
] as const;

export const activityTypeSchema = z.enum(ACTIVITY_TYPES);

export type ActivityType = z.infer<typeof activityTypeSchema>;

// --- Reusable payload fragments --------------------------------------------

const uuid = z.string().uuid();
/** Sequence pause causes (CONTRACTS §C4: sequence_paused reason set). */
export const sequencePausedReasonValues = [
  'reply',
  'bounce',
  'manual',
  'unsubscribe',
] as const;
export const sequencePausedReasonSchema = z.enum(sequencePausedReasonValues);

const jsonValue: z.ZodType<unknown> = z.unknown();

// --- Per-type payload schemas (CONTRACTS §C4) ------------------------------
//
// Only `field_changed` and `sequence_paused` have payloads fixed by the
// contract text; the rest are specified here to the minimum each type needs to
// render a timeline row and feed the denormalization mapping. All are open
// (`.passthrough()`) so provider metadata can ride along without a schema bump.

const callLoggedPayload = z
  .object({
    callId: uuid.optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    durationS: z.number().int().nonnegative().optional(),
    outcome: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const callMissedPayload = z
  .object({
    callId: uuid.optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const voicemailReceivedPayload = z
  .object({
    callId: uuid.optional(),
    recordingRef: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const emailSentPayload = z
  .object({
    emailMessageId: uuid.optional(),
    threadId: uuid.optional(),
    subject: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const emailReceivedPayload = z
  .object({
    emailMessageId: uuid.optional(),
    threadId: uuid.optional(),
    subject: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const emailBouncedPayload = z
  .object({
    emailMessageId: uuid.optional(),
    reason: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const smsSentPayload = z
  .object({
    smsMessageId: uuid.optional(),
    body: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const smsReceivedPayload = z
  .object({
    smsMessageId: uuid.optional(),
    body: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const smsOptOutPayload = z
  .object({
    number: z.string().optional(),
    keyword: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const noteAddedPayload = z
  .object({
    noteId: uuid.optional(),
    aiGenerated: z.boolean().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const taskCreatedPayload = z
  .object({
    taskId: uuid.optional(),
    dueAt: z.string().optional(),
    title: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const taskCompletedPayload = z
  .object({
    taskId: uuid.optional(),
    completedAt: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

/** CONTRACTS §C4: field_changed payload is fixed as {field, before, after}. */
const fieldChangedPayload = z
  .object({
    field: z.string(),
    before: jsonValue,
    after: jsonValue,
  })
  .passthrough();

const statusChangedPayload = z
  .object({
    statusId: uuid.optional(),
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const opportunityCreatedPayload = z
  .object({
    opportunityId: uuid.optional(),
    valueCents: z.number().int().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const opportunityStageChangedPayload = z
  .object({
    opportunityId: uuid.optional(),
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const opportunityClosedPayload = z
  .object({
    opportunityId: uuid.optional(),
    status: z.enum(['won', 'lost']).optional(),
    valueCents: z.number().int().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const sequenceEnrolledPayload = z
  .object({
    enrollmentId: uuid.optional(),
    sequenceId: uuid.optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const sequenceStepSentPayload = z
  .object({
    enrollmentId: uuid.optional(),
    stepId: uuid.optional(),
    channel: z.string().optional(),
  })
  .passthrough();

/** CONTRACTS §C4: sequence_paused payload includes a fixed reason set. */
const sequencePausedPayload = z
  .object({
    enrollmentId: uuid.optional(),
    reason: sequencePausedReasonSchema,
    channel: z.string().optional(),
  })
  .passthrough();

const sequenceFinishedPayload = z
  .object({
    enrollmentId: uuid.optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const unsubscribedPayload = z
  .object({
    value: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const suppressionAddedPayload = z
  .object({
    suppressionId: uuid.optional(),
    kind: z.enum(['email', 'phone']).optional(),
    value: z.string().optional(),
    source: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const suppressionReleasedPayload = z
  .object({
    suppressionId: uuid.optional(),
    releaseReason: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const dncSetPayload = z
  .object({
    scope: z.enum(['lead', 'contact']).optional(),
    contactId: uuid.optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const dncClearedPayload = z
  .object({
    scope: z.enum(['lead', 'contact']).optional(),
    contactId: uuid.optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const leadCreatedPayload = z
  .object({
    channel: z.string().optional(),
  })
  .passthrough();

const leadMergedPayload = z
  .object({
    mergedFromLeadId: uuid.optional(),
    mergedIntoLeadId: uuid.optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const importCreatedPayload = z
  .object({
    importId: uuid.optional(),
    rowCount: z.number().int().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const activityCorrectionPayload = z
  .object({
    correctsActivityId: uuid.optional(),
    reason: z.string().optional(),
    channel: z.string().optional(),
  })
  .passthrough();

const recordingConsentPlayedPayload = z
  .object({
    callId: uuid.optional(),
    channel: z.string().optional(),
  })
  .passthrough();

/**
 * Payload schema per activity type. `Record<ActivityType, …>` guarantees at
 * compile time that every taxonomy member has a schema — add a type to
 * ACTIVITY_TYPES and this object stops type-checking until you supply one.
 */
export const activityPayloadSchemas = {
  call_logged: callLoggedPayload,
  call_missed: callMissedPayload,
  voicemail_received: voicemailReceivedPayload,
  email_sent: emailSentPayload,
  email_received: emailReceivedPayload,
  email_bounced: emailBouncedPayload,
  sms_sent: smsSentPayload,
  sms_received: smsReceivedPayload,
  sms_opt_out: smsOptOutPayload,
  note_added: noteAddedPayload,
  task_created: taskCreatedPayload,
  task_completed: taskCompletedPayload,
  field_changed: fieldChangedPayload,
  status_changed: statusChangedPayload,
  opportunity_created: opportunityCreatedPayload,
  opportunity_stage_changed: opportunityStageChangedPayload,
  opportunity_closed: opportunityClosedPayload,
  sequence_enrolled: sequenceEnrolledPayload,
  sequence_step_sent: sequenceStepSentPayload,
  sequence_paused: sequencePausedPayload,
  sequence_finished: sequenceFinishedPayload,
  unsubscribed: unsubscribedPayload,
  suppression_added: suppressionAddedPayload,
  suppression_released: suppressionReleasedPayload,
  dnc_set: dncSetPayload,
  dnc_cleared: dncClearedPayload,
  lead_created: leadCreatedPayload,
  lead_merged: leadMergedPayload,
  import_created: importCreatedPayload,
  activity_correction: activityCorrectionPayload,
  recording_consent_played: recordingConsentPlayedPayload,
} as const satisfies Record<ActivityType, z.ZodTypeAny>;

export type ActivityPayloadSchemas = typeof activityPayloadSchemas;

/** Inferred payload type for a given activity type. */
export type ActivityPayload<T extends ActivityType> = z.infer<ActivityPayloadSchemas[T]>;

/**
 * Validate a payload against its type's schema. Throws `ZodError` on mismatch —
 * the event writer surfaces this as a rejected `record()` (CONTRACTS §C4: bad
 * payloads never reach the spine).
 */
export function parseActivityPayload<T extends ActivityType>(
  type: T,
  payload: unknown,
): ActivityPayload<T> {
  const schema = activityPayloadSchemas[type];
  return schema.parse(payload) as ActivityPayload<T>;
}
