import type { CallOutcomeDisposition } from './lifecycle.ts';

/*
 * Static pick-lists for the calling surfaces: the outcome dispositions a rep
 * chooses at hang-up, and the pre-recorded voicemail assets a rep can drop into
 * a live call. Both are demo fixtures with real content (no lorem) whose shapes
 * match what the C7 routes accept — `outcome` is a free-text label the PATCH
 * stores verbatim, `recordingRef` is the opaque asset handle the voicemail-drop
 * route forwards to the provider.
 */

export interface CallOutcomeOption {
  /** Stable slug (form value / test hook). */
  id: string;
  /** Human label sent as the call `outcome` and shown on the timeline. */
  label: string;
  /** Terminal C1 status this outcome finalizes the call to. */
  disposition: CallOutcomeDisposition;
}

/** Outcome dispositions offered in the wrap-up panel, most-common first. */
export const CALL_OUTCOMES: readonly CallOutcomeOption[] = [
  { id: 'connected', label: 'Connected', disposition: 'completed' },
  { id: 'left-voicemail', label: 'Left voicemail', disposition: 'voicemail' },
  { id: 'no-answer', label: 'No answer', disposition: 'missed' },
  { id: 'busy', label: 'Busy', disposition: 'missed' },
  { id: 'meeting-booked', label: 'Meeting booked', disposition: 'completed' },
  { id: 'callback-requested', label: 'Callback requested', disposition: 'completed' },
  { id: 'not-interested', label: 'Not interested', disposition: 'completed' },
  { id: 'wrong-number', label: 'Wrong number', disposition: 'completed' },
];

/** Resolve the terminal disposition for a saved outcome label (default completed). */
export function dispositionForOutcome(label: string): CallOutcomeDisposition {
  const match = CALL_OUTCOMES.find((o) => o.label.toLowerCase() === label.trim().toLowerCase());
  return match?.disposition ?? 'completed';
}

export interface VoicemailAsset {
  /** Opaque asset handle forwarded to `POST /calls/:id/voicemail-drop`. */
  recordingRef: string;
  label: string;
  /** Length in seconds, shown so the rep knows what they are dropping. */
  durationS: number;
}

/** The rep's pre-recorded voicemail library (a rep's own recording, never a
 *  consent-gated conversation recording — see the C2 DTO note / §I-REC). */
export const VOICEMAIL_ASSETS: readonly VoicemailAsset[] = [
  { recordingRef: 'vm-intro-first-touch', label: 'Intro — first touch', durationS: 22 },
  { recordingRef: 'vm-follow-up-no-reply', label: 'Follow-up — no reply', durationS: 18 },
  { recordingRef: 'vm-renewal-check-in', label: 'Renewal check-in', durationS: 25 },
];

/**
 * Suppression/DNC match key for a phone number — the last 10 significant digits,
 * mirroring the engine's `phoneMatchKey` closely enough for the mock rails to
 * agree with the real ones (a demo, not E.164 canonicalization).
 */
export function phoneMatchKey(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Format a raw fixture phone (`+1206…`) into a readable US grouping. */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  if (ten.length !== 10) return phone;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}
