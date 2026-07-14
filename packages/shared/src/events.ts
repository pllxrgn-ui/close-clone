import { z } from 'zod';

/**
 * Activity event taxonomy (CONTRACTS §C4). The `activities` table is the
 * append-only spine; each type carries a zod-typed payload. Payload schemas are
 * added alongside the event writer in Phase 1 — this file seeds the type set only.
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
