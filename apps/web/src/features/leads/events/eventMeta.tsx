import type { ActivityType } from '@switchboard/shared';
import type { IconProps } from '../icons.tsx';
import {
  ArrowRightCircleIcon,
  BanIcon,
  BranchIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  FlagIcon,
  HistoryIcon,
  MailIcon,
  MailXIcon,
  MergeIcon,
  MessageIcon,
  MessageOffIcon,
  MicIcon,
  NoteIcon,
  PauseIcon,
  PencilIcon,
  PhoneIcon,
  PhoneMissedIcon,
  SendIcon,
  ShieldCheckIcon,
  SparkleIcon,
  TargetIcon,
  TrophyIcon,
  UploadIcon,
  UserXIcon,
  VoicemailIcon,
} from '../icons.tsx';
import { formatMoneyCentsCompact, truncate } from '../lib/format.ts';

/*
 * The timeline's rendering brain: one entry per CONTRACTS §C4 activity type,
 * giving each a type-appropriate glyph, a state tone (color is spent on state),
 * a verb-phrase label, and an optional payload-derived detail line.
 *
 * `EVENT_META` is `satisfies Record<ActivityType, EventMeta>`, so the taxonomy
 * and this map can never drift: add a type to the C4 enum and this object stops
 * type-checking until it gets an entry. The eventMeta.test.tsx suite additionally
 * asserts every enum member resolves to a *known* (non-fallback) meta.
 */

export type EventTone = 'reply' | 'overdue' | 'seq' | 'dnc' | 'won' | 'lost' | 'neutral';

/** Maps a tone to the class that pulls the matching state color token. */
export const EVENT_TONE_CLASS: Record<EventTone, string> = {
  reply: 'tl-tone--reply',
  overdue: 'tl-tone--overdue',
  seq: 'tl-tone--seq',
  dnc: 'tl-tone--dnc',
  won: 'tl-tone--won',
  lost: 'tl-tone--lost',
  neutral: 'tl-tone--neutral',
};

type Payload = Record<string, unknown>;

export interface EventMeta {
  icon: (props: IconProps) => import('react').JSX.Element;
  tone: EventTone;
  /** Verb-phrase headline, e.g. "Call logged". */
  label: string;
  /** Optional secondary line derived from the (typed-but-permissive) payload. */
  detail?: (payload: Payload) => string | null;
}

// ── Payload readers (payloads are open/passthrough — narrow defensively) ──────

function str(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
function num(payload: Payload, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function fromTo(payload: Payload): string | null {
  const from = str(payload, 'from');
  const to = str(payload, 'to');
  if (to === null && from === null) return null;
  return `${from ?? '—'} → ${to ?? '—'}`;
}

const EVENT_META = {
  call_logged: { icon: PhoneIcon, tone: 'neutral', label: 'Call logged', detail: (p) => str(p, 'outcome') },
  call_missed: { icon: PhoneMissedIcon, tone: 'overdue', label: 'Missed call' },
  voicemail_received: { icon: VoicemailIcon, tone: 'reply', label: 'Voicemail received' },
  email_sent: { icon: SendIcon, tone: 'neutral', label: 'Email sent', detail: (p) => str(p, 'subject') },
  email_received: {
    icon: MailIcon,
    tone: 'reply',
    label: 'Email received',
    detail: (p) => str(p, 'subject'),
  },
  email_bounced: {
    icon: MailXIcon,
    tone: 'dnc',
    label: 'Email bounced',
    detail: (p) => str(p, 'reason'),
  },
  sms_sent: {
    icon: MessageIcon,
    tone: 'neutral',
    label: 'SMS sent',
    detail: (p) => {
      const body = str(p, 'body');
      return body ? truncate(body, 60) : null;
    },
  },
  sms_received: {
    icon: MessageIcon,
    tone: 'reply',
    label: 'SMS received',
    detail: (p) => {
      const body = str(p, 'body');
      return body ? truncate(body, 60) : null;
    },
  },
  sms_opt_out: {
    icon: MessageOffIcon,
    tone: 'dnc',
    label: 'SMS opt-out',
    detail: (p) => {
      const keyword = str(p, 'keyword');
      return keyword ? `Keyword "${keyword}"` : null;
    },
  },
  note_added: {
    icon: NoteIcon,
    tone: 'neutral',
    label: 'Note added',
    detail: (p) => (p.aiGenerated === true ? 'AI-drafted' : null),
  },
  task_created: {
    icon: CircleDashedIcon,
    tone: 'neutral',
    label: 'Task created',
    detail: (p) => str(p, 'title'),
  },
  task_completed: { icon: CheckCircleIcon, tone: 'won', label: 'Task completed' },
  field_changed: {
    icon: PencilIcon,
    tone: 'neutral',
    label: 'Field changed',
    detail: (p) => {
      const field = str(p, 'field');
      return field ? `Changed ${field}` : null;
    },
  },
  status_changed: {
    icon: ArrowRightCircleIcon,
    tone: 'neutral',
    label: 'Status changed',
    detail: fromTo,
  },
  opportunity_created: {
    icon: TargetIcon,
    tone: 'neutral',
    label: 'Opportunity created',
    detail: (p) => {
      const cents = num(p, 'valueCents');
      return cents === null ? null : formatMoneyCentsCompact(cents);
    },
  },
  opportunity_stage_changed: {
    icon: ArrowRightCircleIcon,
    tone: 'neutral',
    label: 'Opportunity stage changed',
    detail: fromTo,
  },
  opportunity_closed: {
    icon: TrophyIcon,
    tone: 'won',
    label: 'Opportunity closed',
    detail: (p) => {
      const status = str(p, 'status');
      const cents = num(p, 'valueCents');
      const money = cents === null ? null : formatMoneyCentsCompact(cents);
      if (status && money) return `${status} · ${money}`;
      return status ?? money;
    },
  },
  sequence_enrolled: { icon: BranchIcon, tone: 'seq', label: 'Enrolled in sequence' },
  sequence_step_sent: { icon: SendIcon, tone: 'seq', label: 'Sequence step sent' },
  sequence_paused: {
    icon: PauseIcon,
    tone: 'seq',
    label: 'Sequence paused',
    detail: (p) => {
      const reason = str(p, 'reason');
      return reason ? `Reason: ${reason}` : null;
    },
  },
  sequence_finished: { icon: FlagIcon, tone: 'won', label: 'Sequence finished' },
  unsubscribed: { icon: UserXIcon, tone: 'dnc', label: 'Unsubscribed' },
  suppression_added: {
    icon: BanIcon,
    tone: 'dnc',
    label: 'Suppression added',
    detail: (p) => str(p, 'value'),
  },
  suppression_released: { icon: ShieldCheckIcon, tone: 'won', label: 'Suppression released' },
  dnc_set: { icon: BanIcon, tone: 'dnc', label: 'Do-not-contact set' },
  dnc_cleared: { icon: ShieldCheckIcon, tone: 'won', label: 'Do-not-contact cleared' },
  lead_created: { icon: SparkleIcon, tone: 'neutral', label: 'Lead created' },
  lead_merged: { icon: MergeIcon, tone: 'neutral', label: 'Lead merged' },
  import_created: {
    icon: UploadIcon,
    tone: 'neutral',
    label: 'Imported',
    detail: (p) => {
      const rows = num(p, 'rowCount');
      return rows === null ? null : `${rows.toLocaleString('en-US')} rows`;
    },
  },
  activity_correction: { icon: HistoryIcon, tone: 'neutral', label: 'Activity corrected' },
  recording_consent_played: {
    icon: MicIcon,
    tone: 'neutral',
    label: 'Recording consent played',
  },
} as const satisfies Record<ActivityType, EventMeta>;

/** Defensive fallback for a type outside the known taxonomy (never used for C4). */
export const FALLBACK_EVENT_META: EventMeta = {
  icon: CircleDashedIcon,
  tone: 'neutral',
  label: 'Activity',
};

/** True when `type` is a known C4 activity type with a dedicated meta entry. */
export function isKnownEventType(type: string): type is ActivityType {
  return Object.prototype.hasOwnProperty.call(EVENT_META, type);
}

/** Resolve rendering meta for an activity type, falling back defensively. */
export function resolveEventMeta(type: string): EventMeta {
  return isKnownEventType(type) ? EVENT_META[type] : FALLBACK_EVENT_META;
}

export { EVENT_META };
