/*
 * Pure report aggregation — the in-memory analogue of the API's SQL
 * (apps/api/src/services/reports/{activity,funnel,sequences}.ts). Kept as pure
 * functions over plain arrays so the math is unit-testable without HTTP and the
 * MSW handlers stay thin. Semantics mirror the SQL exactly so the numbers match
 * real mode:
 *
 *  - activity: bucket by user id (or UTC day); counts off the reported event
 *    types; talk time summed from call durations; a userId filter seeds a
 *    zero-row so a rep with no activity still appears.
 *  - funnel: group by (currency, stage); open = active snapshot, won/lost scoped
 *    by close date, entered/exited from stage-change events; currencies never sum.
 *  - sequences: per-sequence event counts (attributed via enrollment) + the
 *    current enrollment snapshot; anchored on sequences so zero-activity shows.
 */
import type { OpportunityStage, User } from '@switchboard/shared';
import { resolveRange } from '../lib/range.ts';
import { emptyActivityRow } from '../lib/totals.ts';
import type {
  ActivityGroupBy,
  ActivityReportRow,
  FunnelStageRow,
  SequenceReportRow,
} from '../types.ts';

export { sumActivityRows } from '../lib/totals.ts';
import type {
  ActivityEventSeed,
  CallSeed,
  EnrollmentSeed,
  FunnelOppSeed,
  SequenceEventSeed,
  SequenceSeed,
  StageChangeSeed,
} from './seed.ts';

/** Event types the activity report buckets (mirrors API `REPORTED_TYPES`). */
export const REPORTED_TYPES: ReadonlySet<string> = new Set([
  'call_logged',
  'call_missed',
  'voicemail_received',
  'email_sent',
  'email_received',
  'sms_sent',
  'sms_received',
  'note_added',
  'task_completed',
]);

function msOf(iso: string): number {
  return new Date(iso).getTime();
}

/** UTC calendar day (`YYYY-MM-DD`) of an ISO instant. */
function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

// ── Activity ─────────────────────────────────────────────────────────────────

export interface AggregateActivityParams {
  events: readonly ActivityEventSeed[];
  calls: readonly CallSeed[];
  reps: ReadonlyArray<Pick<User, 'id'>>;
  from: string;
  to: string;
  userId?: string;
  groupBy?: ActivityGroupBy;
}

export function aggregateActivity(params: AggregateActivityParams): ActivityReportRow[] {
  const { events, calls, reps, from, to } = params;
  const mode: ActivityGroupBy = params.groupBy ?? 'user';
  const userId = params.userId;
  const { fromMs, toExclusiveMs } = resolveRange(from, to);

  const rows = new Map<string, ActivityReportRow>();
  const talk = new Map<string, number>();

  const ensure = (bucket: string): ActivityReportRow => {
    let row = rows.get(bucket);
    if (!row) {
      row = emptyActivityRow(bucket);
      rows.set(bucket, row);
    }
    return row;
  };

  for (const ev of events) {
    if (!REPORTED_TYPES.has(ev.type)) continue;
    const t = msOf(ev.occurredAt);
    if (t < fromMs || t >= toExclusiveMs) continue;
    const hasUser = typeof ev.userId === 'string' && ev.userId.length > 0;
    if (mode === 'user' && !hasUser) continue;
    if (userId !== undefined && ev.userId !== userId) continue;

    const bucket = mode === 'user' ? ev.userId : utcDay(ev.occurredAt);
    const row = ensure(bucket);
    switch (ev.type) {
      case 'call_logged': {
        row.callsLogged += 1;
        if (ev.direction === 'inbound') row.callsInbound += 1;
        else if (ev.direction === 'outbound') row.callsOutbound += 1;
        const outcome = ev.outcome ?? 'unknown';
        row.callsByOutcome[outcome] = (row.callsByOutcome[outcome] ?? 0) + 1;
        break;
      }
      case 'call_missed':
        row.callsMissed += 1;
        break;
      case 'voicemail_received':
        row.voicemails += 1;
        break;
      case 'email_sent':
        row.emailsSent += 1;
        break;
      case 'email_received':
        row.emailsReceived += 1;
        break;
      case 'sms_sent':
        row.smsSent += 1;
        break;
      case 'sms_received':
        row.smsReceived += 1;
        break;
      case 'note_added':
        row.notesAdded += 1;
        break;
      case 'task_completed':
        row.tasksCompleted += 1;
        break;
      default:
        break;
    }
  }

  for (const call of calls) {
    const t = msOf(call.startedAt);
    if (t < fromMs || t >= toExclusiveMs) continue;
    const hasUser = typeof call.userId === 'string' && call.userId.length > 0;
    if (mode === 'user' && !hasUser) continue;
    if (userId !== undefined && call.userId !== userId) continue;
    const bucket = mode === 'user' ? call.userId : utcDay(call.startedAt);
    talk.set(bucket, (talk.get(bucket) ?? 0) + call.durationS);
  }

  // Seed a zero-row for a filtered rep with no activity (mirrors the `userSeed` UNION).
  if (mode === 'user' && userId !== undefined && reps.some((r) => r.id === userId)) {
    ensure(userId);
  }

  const keys = new Set<string>([...rows.keys(), ...talk.keys()]);
  const out: ActivityReportRow[] = [];
  for (const key of keys) {
    const row = rows.get(key) ?? emptyActivityRow(key);
    row.talkTimeSeconds = talk.get(key) ?? 0;
    out.push(row);
  }
  out.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
  return out;
}

// ── Funnel ───────────────────────────────────────────────────────────────────

export interface AggregateFunnelParams {
  opps: readonly FunnelOppSeed[];
  stageChanges: readonly StageChangeSeed[];
  stages: ReadonlyArray<Pick<OpportunityStage, 'id' | 'label' | 'sortOrder'>>;
  from?: string;
  to?: string;
  currency?: string;
}

interface FunnelAcc {
  openCount: number;
  openValueCents: number;
  openWeightedRaw: number;
  wonCount: number;
  wonValueCents: number;
  lostCount: number;
  lostValueCents: number;
  enteredCount: number;
  exitedCount: number;
}

function emptyFunnelAcc(): FunnelAcc {
  return {
    openCount: 0,
    openValueCents: 0,
    openWeightedRaw: 0,
    wonCount: 0,
    wonValueCents: 0,
    lostCount: 0,
    lostValueCents: 0,
    enteredCount: 0,
    exitedCount: 0,
  };
}

const cellKey = (currency: string, stageId: string): string => `${currency}::${stageId}`;

export function aggregateFunnel(params: AggregateFunnelParams): FunnelStageRow[] {
  const { opps, stageChanges, stages } = params;
  const currency = params.currency;
  const hasRange = params.from !== undefined && params.to !== undefined;
  let closeFrom: string | null = null;
  let closeToExcl: string | null = null;
  let convFromMs = Number.NEGATIVE_INFINITY;
  let convToExclMs = Number.POSITIVE_INFINITY;
  if (hasRange && params.from !== undefined && params.to !== undefined) {
    const r = resolveRange(params.from, params.to);
    closeFrom = r.fromDate;
    closeToExcl = r.toExclusiveDate;
    convFromMs = r.fromMs;
    convToExclMs = r.toExclusiveMs;
  }

  const stageById = new Map(stages.map((s) => [s.id, s] as const));
  const acc = new Map<string, FunnelAcc>();
  const ensure = (key: string): FunnelAcc => {
    let a = acc.get(key);
    if (!a) {
      a = emptyFunnelAcc();
      acc.set(key, a);
    }
    return a;
  };
  const inClose = (closeDate: string): boolean =>
    closeFrom === null ||
    closeToExcl === null ||
    (closeDate >= closeFrom && closeDate < closeToExcl);

  for (const opp of opps) {
    if (currency !== undefined && opp.currency !== currency) continue;
    if (!stageById.has(opp.stageId)) continue;
    const a = ensure(cellKey(opp.currency, opp.stageId));
    if (opp.status === 'active') {
      a.openCount += 1;
      a.openValueCents += opp.valueCents;
      a.openWeightedRaw += (opp.valueCents * opp.confidence) / 100;
    } else if (opp.status === 'won' && inClose(opp.closeDate)) {
      a.wonCount += 1;
      a.wonValueCents += opp.valueCents;
    } else if (opp.status === 'lost' && inClose(opp.closeDate)) {
      a.lostCount += 1;
      a.lostValueCents += opp.valueCents;
    }
  }

  for (const change of stageChanges) {
    if (currency !== undefined && change.currency !== currency) continue;
    const t = msOf(change.occurredAt);
    if (t < convFromMs || t >= convToExclMs) continue;
    if (change.to !== null && stageById.has(change.to)) {
      ensure(cellKey(change.currency, change.to)).enteredCount += 1;
    }
    if (change.from !== null && stageById.has(change.from)) {
      ensure(cellKey(change.currency, change.from)).exitedCount += 1;
    }
  }

  const rows: FunnelStageRow[] = [];
  for (const [key, a] of acc) {
    const sep = key.indexOf('::');
    const cur = key.slice(0, sep);
    const stageId = key.slice(sep + 2);
    const stage = stageById.get(stageId);
    if (!stage) continue;
    rows.push({
      currency: cur,
      stageId,
      stageLabel: stage.label,
      stageSortOrder: stage.sortOrder,
      openCount: a.openCount,
      openValueCents: a.openValueCents,
      openWeightedValueCents: Math.round(a.openWeightedRaw),
      wonCount: a.wonCount,
      wonValueCents: a.wonValueCents,
      lostCount: a.lostCount,
      lostValueCents: a.lostValueCents,
      enteredCount: a.enteredCount,
      exitedCount: a.exitedCount,
    });
  }
  rows.sort((x, y) => {
    if (x.currency !== y.currency) return x.currency < y.currency ? -1 : 1;
    if (x.stageSortOrder !== y.stageSortOrder) return x.stageSortOrder - y.stageSortOrder;
    return x.stageId < y.stageId ? -1 : x.stageId > y.stageId ? 1 : 0;
  });
  return rows;
}

// ── Sequences ────────────────────────────────────────────────────────────────

export interface AggregateSequencesParams {
  sequences: readonly SequenceSeed[];
  enrollments: readonly EnrollmentSeed[];
  events: readonly SequenceEventSeed[];
  from?: string;
  to?: string;
  sequenceId?: string;
}

interface SeqAcc {
  sends: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
  finishes: number;
}

export function aggregateSequences(params: AggregateSequencesParams): SequenceReportRow[] {
  const { sequences, enrollments, events } = params;
  const hasRange = params.from !== undefined && params.to !== undefined;
  let fromMs = Number.NEGATIVE_INFINITY;
  let toExclusiveMs = Number.POSITIVE_INFINITY;
  if (hasRange && params.from !== undefined && params.to !== undefined) {
    const r = resolveRange(params.from, params.to);
    fromMs = r.fromMs;
    toExclusiveMs = r.toExclusiveMs;
  }

  const seqOfEnrollment = new Map(enrollments.map((e) => [e.id, e.sequenceId] as const));
  const evAcc = new Map<string, SeqAcc>();
  const ensure = (sid: string): SeqAcc => {
    let a = evAcc.get(sid);
    if (!a) {
      a = { sends: 0, replies: 0, bounces: 0, unsubscribes: 0, finishes: 0 };
      evAcc.set(sid, a);
    }
    return a;
  };

  for (const ev of events) {
    const sid = seqOfEnrollment.get(ev.enrollmentId);
    if (sid === undefined) continue;
    const t = msOf(ev.occurredAt);
    if (t < fromMs || t >= toExclusiveMs) continue;
    const a = ensure(sid);
    if (ev.type === 'sequence_step_sent') a.sends += 1;
    else if (ev.type === 'sequence_finished') a.finishes += 1;
    else if (ev.type === 'sequence_paused') {
      if (ev.reason === 'reply') a.replies += 1;
      else if (ev.reason === 'bounce') a.bounces += 1;
      else if (ev.reason === 'unsubscribe') a.unsubscribes += 1;
    }
  }

  const enr = new Map<string, { active: number; paused: number }>();
  for (const e of enrollments) {
    let c = enr.get(e.sequenceId);
    if (!c) {
      c = { active: 0, paused: 0 };
      enr.set(e.sequenceId, c);
    }
    if (e.state === 'active') c.active += 1;
    else if (e.state === 'paused') c.paused += 1;
  }

  const rows: SequenceReportRow[] = [];
  for (const seq of sequences) {
    if (params.sequenceId !== undefined && seq.id !== params.sequenceId) continue;
    const a = evAcc.get(seq.id);
    const c = enr.get(seq.id);
    rows.push({
      sequenceId: seq.id,
      sequenceName: seq.name,
      sequenceStatus: seq.status,
      sends: a?.sends ?? 0,
      replies: a?.replies ?? 0,
      bounces: a?.bounces ?? 0,
      unsubscribes: a?.unsubscribes ?? 0,
      finishes: a?.finishes ?? 0,
      activeEnrollments: c?.active ?? 0,
      pausedEnrollments: c?.paused ?? 0,
    });
  }
  rows.sort((x, y) => {
    if (x.sequenceName !== y.sequenceName) return x.sequenceName < y.sequenceName ? -1 : 1;
    return x.sequenceId < y.sequenceId ? -1 : x.sequenceId > y.sequenceId ? 1 : 0;
  });
  return rows;
}
