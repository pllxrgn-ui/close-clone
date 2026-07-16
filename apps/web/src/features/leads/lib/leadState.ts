import type { Lead } from '@switchboard/shared';
import type { StatusTone } from '../../../ui/index.ts';

/*
 * Status-board state derivation. Color is spent almost entirely on STATE, so the
 * whole leads table reads like a board at a glance. States are derived from the
 * denormalized hot columns the event-writer maintains (CONTRACTS §C1/§C4):
 *
 *   newReply   — an inbound touch newer than our last outbound (needs a reply)
 *   overdue    — the next task is past due
 *   inSequence — enrolled in an active sequence (see note below)
 *   dnc        — do-not-contact (compliance; dominates the rail)
 *
 * NOTE (contract friction, reported upward): the C1 `leads` row denormalizes
 * last-touch/next-task/dnc but NOT sequence membership (that lives in
 * `sequence_enrollments`, a join the list endpoint doesn't surface). So the
 * `inSequence` state is part of the vocabulary — legend, pills, rail, precedence
 * all support it — but `deriveLeadStates` cannot light it from a bare Lead until
 * the API denormalizes an in-sequence flag onto the row.
 */

export const LEAD_STATE_KEYS = ['newReply', 'overdue', 'inSequence', 'dnc'] as const;
export type LeadStateKey = (typeof LEAD_STATE_KEYS)[number];

export interface LeadStateMeta {
  key: LeadStateKey;
  /** Wide-tracked uppercase state word (pills/legend). */
  label: string;
  /** StatusPill tone (maps to the AA-verified state token pair). */
  tone: StatusTone;
  /** CSS var for the leading rail / dot solid color. */
  solidVar: string;
  /** Whether this state is a glowing lamp (reply) — glow is dark-theme only. */
  lamp: boolean;
  description: string;
}

export const LEAD_STATE: Record<LeadStateKey, LeadStateMeta> = {
  newReply: {
    key: 'newReply',
    label: 'New reply',
    tone: 'newReply',
    solidVar: '--state-new-reply-solid',
    lamp: true,
    description: 'Inbound reply newer than our last outbound touch',
  },
  overdue: {
    key: 'overdue',
    label: 'Overdue',
    tone: 'overdue',
    solidVar: '--state-overdue-solid',
    lamp: false,
    description: 'Next task is past due',
  },
  inSequence: {
    key: 'inSequence',
    label: 'In sequence',
    tone: 'inSequence',
    solidVar: '--state-in-sequence-solid',
    lamp: false,
    description: 'Enrolled in an active sequence',
  },
  dnc: {
    key: 'dnc',
    label: 'DNC',
    tone: 'dnc',
    solidVar: '--state-dnc-solid',
    lamp: false,
    description: 'Do not contact (compliance)',
  },
};

/**
 * Precedence for the single leading rail color when several states apply.
 * DNC dominates (compliance), then a hot inbound reply, then an overdue action,
 * then ambient sequence membership.
 */
export const LEAD_STATE_PRECEDENCE: readonly LeadStateKey[] = [
  'dnc',
  'newReply',
  'overdue',
  'inSequence',
];

/** Fields the derivation reads — accepts a full Lead or a minimal projection. */
export type LeadStateInput = Pick<
  Lead,
  'dnc' | 'lastInboundAt' | 'lastContactedAt' | 'nextTaskDueAt'
>;

function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

export function isNewReply(lead: LeadStateInput): boolean {
  const inbound = ms(lead.lastInboundAt);
  if (inbound === null) return false;
  const contacted = ms(lead.lastContactedAt);
  return contacted === null || inbound > contacted;
}

export function isOverdue(lead: LeadStateInput, now: Date): boolean {
  const due = ms(lead.nextTaskDueAt);
  return due !== null && due < now.getTime();
}

/** All applicable states, ordered by rail precedence (most urgent first). */
export function deriveLeadStates(lead: LeadStateInput, now: Date = new Date()): LeadStateKey[] {
  const applicable = new Set<LeadStateKey>();
  if (lead.dnc) applicable.add('dnc');
  if (isNewReply(lead)) applicable.add('newReply');
  if (isOverdue(lead, now)) applicable.add('overdue');
  // inSequence intentionally not derivable from a bare Lead (see file header).
  return LEAD_STATE_PRECEDENCE.filter((key) => applicable.has(key));
}

/** The single highest-precedence state (drives the leading rail), or null. */
export function primaryLeadState(
  lead: LeadStateInput,
  now: Date = new Date(),
): LeadStateKey | null {
  return deriveLeadStates(lead, now)[0] ?? null;
}
