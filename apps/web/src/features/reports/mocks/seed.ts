/*
 * Deterministic report seed for MSW (S4). Derived read-only from the shared
 * fixture `db` (reps = db.users, stages = db.opportunityStages) so rep names and
 * stage identities line up with the rest of the app, then extended with the
 * report-shaped raw data the base fixture doesn't carry: dated per-rep activity
 * events + call durations, a multi-currency opportunity population with
 * stage-change events, and sequence enrollments + event streams.
 *
 * Everything is EXACT BY CONSTRUCTION: activity counts are a fixed per-rep daily
 * profile held constant across the window, and funnel/sequence counts are the
 * explicit specs below. That lets the aggregation be asserted to the unit against
 * the seed (see aggregate.test.ts) while still reading as real operator data.
 *
 * The handlers recompute report rows from these raw arrays on every request, so a
 * date-range change genuinely re-queries (a narrower window sees fewer events).
 */
import type { OpportunityStage, User } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import { MS_PER_DAY, REPORT_NOW } from '../lib/range.ts';
import type { SequenceStatus } from '../types.ts';

// ── Raw record shapes (a thin analogue of the C1/C4 rows the API scans) ───────

export interface ActivityEventSeed {
  userId: string;
  type: string;
  occurredAt: string;
  direction?: 'inbound' | 'outbound';
  outcome?: string;
}

export interface CallSeed {
  userId: string;
  startedAt: string;
  durationS: number;
}

export interface FunnelOppSeed {
  id: string;
  currency: string;
  stageId: string;
  status: 'active' | 'won' | 'lost';
  valueCents: number;
  confidence: number;
  closeDate: string;
}

export interface StageChangeSeed {
  opportunityId: string;
  currency: string;
  from: string | null;
  to: string | null;
  occurredAt: string;
}

export interface SequenceSeed {
  id: string;
  name: string;
  status: SequenceStatus;
}

export interface EnrollmentSeed {
  id: string;
  sequenceId: string;
  state: 'active' | 'paused' | 'finished' | 'unenrolled';
}

export interface SequenceEventSeed {
  enrollmentId: string;
  type: 'sequence_step_sent' | 'sequence_paused' | 'sequence_finished';
  reason?: 'reply' | 'bounce' | 'unsubscribe' | 'manual';
  occurredAt: string;
}

export interface ReportSeed {
  reps: User[];
  stages: OpportunityStage[];
  currencies: string[];
  activityEvents: ActivityEventSeed[];
  calls: CallSeed[];
  funnelOpps: FunnelOppSeed[];
  stageChanges: StageChangeSeed[];
  sequences: SequenceSeed[];
  enrollments: EnrollmentSeed[];
  sequenceEvents: SequenceEventSeed[];
}

// ── Activity: fixed per-rep daily profile over a 90-day window ────────────────

export const WINDOW_DAYS = 90;

export interface RepDailyProfile {
  callsOut: number;
  callsIn: number;
  callsMissed: number;
  voicemails: number;
  emailsOut: number;
  emailsIn: number;
  smsOut: number;
  smsIn: number;
  notes: number;
  tasks: number;
}

/** Per-rep, per-day counts (constant across the window → totals are days × count). */
export const REP_PROFILES: readonly RepDailyProfile[] = [
  { callsOut: 6, callsIn: 2, callsMissed: 1, voicemails: 1, emailsOut: 8, emailsIn: 4, smsOut: 2, smsIn: 1, notes: 3, tasks: 2 },
  { callsOut: 3, callsIn: 1, callsMissed: 1, voicemails: 0, emailsOut: 10, emailsIn: 5, smsOut: 1, smsIn: 1, notes: 2, tasks: 1 },
  { callsOut: 4, callsIn: 2, callsMissed: 0, voicemails: 1, emailsOut: 5, emailsIn: 3, smsOut: 3, smsIn: 2, notes: 1, tasks: 2 },
  { callsOut: 2, callsIn: 1, callsMissed: 1, voicemails: 1, emailsOut: 6, emailsIn: 2, smsOut: 1, smsIn: 0, notes: 2, tasks: 1 },
  { callsOut: 5, callsIn: 1, callsMissed: 0, voicemails: 0, emailsOut: 4, emailsIn: 2, smsOut: 0, smsIn: 1, notes: 1, tasks: 3 },
];

/** Outbound call outcomes cycled per call, with a fixed talk duration each (s). */
export const OUT_OUTCOMES = ['connected', 'voicemail', 'no_answer', 'meeting_booked'] as const;
export const OUT_DUR = [420, 30, 0, 900] as const;
export const IN_DUR = 300;

export function profileFor(index: number): RepDailyProfile {
  const p = REP_PROFILES[index % REP_PROFILES.length];
  if (!p) throw new Error('REP_PROFILES must be non-empty');
  return p;
}

/** call_logged per day for a profile (inbound + outbound). */
export function dailyCallsLogged(p: RepDailyProfile): number {
  return p.callsOut + p.callsIn;
}

/** Talk seconds per day for a profile (Σ outbound durations + inbound × IN_DUR). */
export function dailyTalkSeconds(p: RepDailyProfile): number {
  let s = p.callsIn * IN_DUR;
  for (let k = 0; k < p.callsOut; k += 1) s += OUT_DUR[k % OUT_DUR.length] ?? 0;
  return s;
}

function utcDayStartMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dayIso(dayOffset: number, secondOffset: number): string {
  // 14:00Z anchor keeps every event comfortably inside its UTC calendar day.
  const ms = utcDayStartMs(REPORT_NOW) - dayOffset * MS_PER_DAY + 14 * 3_600_000 + secondOffset * 1000;
  return new Date(ms).toISOString();
}

function buildActivity(reps: User[]): { activityEvents: ActivityEventSeed[]; calls: CallSeed[] } {
  const activityEvents: ActivityEventSeed[] = [];
  const calls: CallSeed[] = [];

  reps.forEach((rep, repIndex) => {
    const p = profileFor(repIndex);
    for (let d = 0; d < WINDOW_DAYS; d += 1) {
      let sec = 0;
      const at = (): string => dayIso(d, sec++);

      for (let k = 0; k < p.callsOut; k += 1) {
        const outcome = OUT_OUTCOMES[k % OUT_OUTCOMES.length] ?? 'connected';
        const dur = OUT_DUR[k % OUT_DUR.length] ?? 0;
        const occurredAt = at();
        activityEvents.push({ userId: rep.id, type: 'call_logged', occurredAt, direction: 'outbound', outcome });
        calls.push({ userId: rep.id, startedAt: occurredAt, durationS: dur });
      }
      for (let k = 0; k < p.callsIn; k += 1) {
        const occurredAt = at();
        activityEvents.push({ userId: rep.id, type: 'call_logged', occurredAt, direction: 'inbound', outcome: 'connected' });
        calls.push({ userId: rep.id, startedAt: occurredAt, durationS: IN_DUR });
      }
      for (let k = 0; k < p.callsMissed; k += 1) {
        activityEvents.push({ userId: rep.id, type: 'call_missed', occurredAt: at() });
      }
      for (let k = 0; k < p.voicemails; k += 1) {
        activityEvents.push({ userId: rep.id, type: 'voicemail_received', occurredAt: at() });
      }
      for (let k = 0; k < p.emailsOut; k += 1) {
        activityEvents.push({ userId: rep.id, type: 'email_sent', occurredAt: at() });
      }
      for (let k = 0; k < p.emailsIn; k += 1) {
        activityEvents.push({ userId: rep.id, type: 'email_received', occurredAt: at() });
      }
      for (let k = 0; k < p.smsOut; k += 1) {
        activityEvents.push({ userId: rep.id, type: 'sms_sent', occurredAt: at() });
      }
      for (let k = 0; k < p.smsIn; k += 1) {
        activityEvents.push({ userId: rep.id, type: 'sms_received', occurredAt: at() });
      }
      for (let k = 0; k < p.notes; k += 1) {
        activityEvents.push({ userId: rep.id, type: 'note_added', occurredAt: at() });
      }
      for (let k = 0; k < p.tasks; k += 1) {
        activityEvents.push({ userId: rep.id, type: 'task_completed', occurredAt: at() });
      }
    }
  });

  return { activityEvents, calls };
}

// ── Funnel: multi-currency opportunity population + stage changes ─────────────

export const CURRENCIES = ['USD', 'EUR'] as const;

/** Opportunity counts per stage (aligned to stage sort order 0..n), per currency. */
export const FUNNEL_COUNTS: Record<string, readonly number[]> = {
  USD: [18, 11, 6, 9, 5],
  EUR: [8, 5, 3, 4, 2],
};

const STAGE_VALUE_UNITS = [8_000, 15_000, 30_000, 22_000, 12_000];
const STAGE_VALUE_STEP = 500;
const STAGE_CONFIDENCE = [20, 45, 70, 100, 0];

export type StageKind = 'open' | 'won' | 'lost';

/** Classify a stage from its label — won/lost are the two terminal columns. */
export function stageKind(label: string): StageKind {
  if (/won/i.test(label)) return 'won';
  if (/lost/i.test(label)) return 'lost';
  return 'open';
}

function dateOnly(dayOffset: number): string {
  return new Date(utcDayStartMs(REPORT_NOW) - dayOffset * MS_PER_DAY).toISOString().slice(0, 10);
}

function buildFunnel(stages: OpportunityStage[]): {
  funnelOpps: FunnelOppSeed[];
  stageChanges: StageChangeSeed[];
} {
  const ordered = [...stages].sort((a, b) => a.sortOrder - b.sortOrder);
  const funnelOpps: FunnelOppSeed[] = [];

  for (const currency of CURRENCIES) {
    const counts = FUNNEL_COUNTS[currency] ?? [];
    ordered.forEach((stage, i) => {
      const kind = stageKind(stage.label);
      const status: FunnelOppSeed['status'] = kind === 'won' ? 'won' : kind === 'lost' ? 'lost' : 'active';
      const count = counts[i] ?? 0;
      const baseUnits = STAGE_VALUE_UNITS[i] ?? 10_000;
      const baseConf = STAGE_CONFIDENCE[i] ?? 50;
      for (let k = 0; k < count; k += 1) {
        funnelOpps.push({
          id: `opp-${currency}-${i}-${k}`,
          currency,
          stageId: stage.id,
          status,
          valueCents: (baseUnits + k * STAGE_VALUE_STEP) * 100,
          confidence: Math.min(100, Math.max(0, baseConf + (k % 5) * 2)),
          // Closed deals close within the window; open deals close ahead of it.
          closeDate: status === 'active' ? dateOnly(-(k + 10)) : dateOnly(k * 4 + 3),
        });
      }
    });
  }

  // A handful of stage-conversion events so entered/exited are real (currency-scoped).
  const stageChanges: StageChangeSeed[] = [];
  const byOrder = new Map(ordered.map((s, i) => [i, s.id] as const));
  const convPlan: Record<string, ReadonlyArray<readonly [number, number, number]>> = {
    USD: [
      [0, 1, 3],
      [1, 2, 2],
      [2, 3, 1],
    ],
    EUR: [
      [0, 1, 2],
      [1, 2, 1],
    ],
  };
  for (const currency of CURRENCIES) {
    let n = 0;
    for (const [fromIdx, toIdx, count] of convPlan[currency] ?? []) {
      for (let c = 0; c < count; c += 1) {
        stageChanges.push({
          opportunityId: `opp-${currency}-${toIdx}-${c}`,
          currency,
          from: byOrder.get(fromIdx) ?? null,
          to: byOrder.get(toIdx) ?? null,
          occurredAt: dayIso((n % 20) + 1, 0),
        });
        n += 1;
      }
    }
  }

  return { funnelOpps, stageChanges };
}

// ── Sequences: explicit per-sequence spec realized as enrollments + events ────

export interface SequenceSpec {
  name: string;
  status: SequenceStatus;
  sends: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
  finishes: number;
  active: number;
  paused: number;
}

/** Reply rates span every meter band: 22.5%, 11.25%, 3.1%, 0 (no sends), 17.8%. */
export const SEQ_SPEC: readonly SequenceSpec[] = [
  { name: 'Cold Outreach — Q3', status: 'active', sends: 120, replies: 27, bounces: 6, unsubscribes: 3, finishes: 40, active: 52, paused: 14 },
  { name: 'Demo Follow-up', status: 'active', sends: 80, replies: 9, bounces: 2, unsubscribes: 1, finishes: 33, active: 20, paused: 8 },
  { name: 'Renewal Nudge', status: 'active', sends: 64, replies: 2, bounces: 5, unsubscribes: 4, finishes: 30, active: 12, paused: 9 },
  { name: 'Win-back', status: 'archived', sends: 0, replies: 0, bounces: 0, unsubscribes: 0, finishes: 0, active: 0, paused: 0 },
  { name: 'Onboarding', status: 'active', sends: 45, replies: 8, bounces: 1, unsubscribes: 0, finishes: 22, active: 18, paused: 3 },
];

function buildSequences(): {
  sequences: SequenceSeed[];
  enrollments: EnrollmentSeed[];
  sequenceEvents: SequenceEventSeed[];
} {
  const sequences: SequenceSeed[] = [];
  const enrollments: EnrollmentSeed[] = [];
  const sequenceEvents: SequenceEventSeed[] = [];

  SEQ_SPEC.forEach((spec, i) => {
    const sequenceId = `seq-${i}`;
    sequences.push({ id: sequenceId, name: spec.name, status: spec.status });

    const enrollmentIds: string[] = [];
    for (let a = 0; a < spec.active; a += 1) {
      const id = `enr-${i}-a-${a}`;
      enrollments.push({ id, sequenceId, state: 'active' });
      enrollmentIds.push(id);
    }
    for (let p = 0; p < spec.paused; p += 1) {
      const id = `enr-${i}-p-${p}`;
      enrollments.push({ id, sequenceId, state: 'paused' });
      enrollmentIds.push(id);
    }
    // Any events need an enrollment to hang off (join key). Ensure at least one.
    if (enrollmentIds.length === 0 && spec.sends + spec.finishes + spec.replies > 0) {
      const id = `enr-${i}-x-0`;
      enrollments.push({ id, sequenceId, state: 'finished' });
      enrollmentIds.push(id);
    }

    let n = 0;
    const push = (
      type: SequenceEventSeed['type'],
      count: number,
      reason?: SequenceEventSeed['reason'],
    ): void => {
      for (let k = 0; k < count; k += 1) {
        const enrollmentId = enrollmentIds[n % enrollmentIds.length] ?? `enr-${i}-a-0`;
        // Spread across the last 30 days so a narrow range genuinely sees fewer.
        const occurredAt = dayIso(n % 30, 0);
        sequenceEvents.push(reason ? { enrollmentId, type, reason, occurredAt } : { enrollmentId, type, occurredAt });
        n += 1;
      }
    };
    push('sequence_step_sent', spec.sends);
    push('sequence_paused', spec.replies, 'reply');
    push('sequence_paused', spec.bounces, 'bounce');
    push('sequence_paused', spec.unsubscribes, 'unsubscribe');
    push('sequence_finished', spec.finishes);
  });

  return { sequences, enrollments, sequenceEvents };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function buildReportSeed(): ReportSeed {
  const reps = db.users;
  const stages = db.opportunityStages;
  const { activityEvents, calls } = buildActivity(reps);
  const { funnelOpps, stageChanges } = buildFunnel(stages);
  const { sequences, enrollments, sequenceEvents } = buildSequences();
  return {
    reps,
    stages,
    currencies: [...CURRENCIES],
    activityEvents,
    calls,
    funnelOpps,
    stageChanges,
    sequences,
    enrollments,
    sequenceEvents,
  };
}

/** The single deterministic report seed backing the MSW report handlers. */
export const reportSeed: ReportSeed = buildReportSeed();
