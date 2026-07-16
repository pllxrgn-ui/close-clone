import { describe, expect, test } from 'vitest';
import { presetRange } from '../lib/range.ts';
import {
  aggregateActivity,
  aggregateFunnel,
  aggregateSequences,
  sumActivityRows,
} from './aggregate.ts';
import type {
  ActivityEventSeed,
  CallSeed,
  EnrollmentSeed,
  FunnelOppSeed,
  SequenceEventSeed,
  SequenceSeed,
  StageChangeSeed,
} from './seed.ts';
import {
  CURRENCIES,
  FUNNEL_COUNTS,
  OUT_OUTCOMES,
  REP_PROFILES,
  SEQ_SPEC,
  WINDOW_DAYS,
  dailyCallsLogged,
  dailyTalkSeconds,
  profileFor,
  reportSeed,
  stageKind,
} from './seed.ts';
import type { ActivityReportRow, FunnelStageRow, SequenceReportRow } from '../types.ts';

// ── Activity: exact math on a small hand fixture ─────────────────────────────

const DAY_A = '2026-07-15T14:00:00.000Z';
const DAY_B = '2026-07-14T14:00:00.000Z';

function ev(
  userId: string,
  type: string,
  occurredAt: string,
  extra: Partial<ActivityEventSeed> = {},
): ActivityEventSeed {
  return { userId, type, occurredAt, ...extra };
}

const HAND_EVENTS: ActivityEventSeed[] = [
  // u1, day A
  ev('u1', 'call_logged', DAY_A, { direction: 'outbound', outcome: 'connected' }),
  ev('u1', 'call_logged', DAY_A, { direction: 'outbound', outcome: 'connected' }),
  ev('u1', 'call_logged', DAY_A, { direction: 'inbound', outcome: 'connected' }),
  ev('u1', 'email_sent', DAY_A),
  ev('u1', 'email_sent', DAY_A),
  ev('u1', 'email_sent', DAY_A),
  ev('u1', 'email_received', DAY_A),
  ev('u1', 'email_received', DAY_A),
  ev('u1', 'sms_sent', DAY_A),
  ev('u1', 'sms_received', DAY_A),
  ev('u1', 'note_added', DAY_A),
  ev('u1', 'task_completed', DAY_A),
  ev('u1', 'call_missed', DAY_A),
  ev('u1', 'voicemail_received', DAY_A),
  // u1, day B
  ev('u1', 'call_logged', DAY_B, { direction: 'outbound', outcome: 'voicemail' }),
  ev('u1', 'email_sent', DAY_B),
  // u2, day A
  ev('u2', 'email_sent', DAY_A),
  ev('u2', 'email_sent', DAY_A),
  ev('u2', 'email_sent', DAY_A),
  ev('u2', 'email_sent', DAY_A),
  ev('u2', 'email_sent', DAY_A),
  // an unattributed event (null user) + a non-reported type — both must be ignored
  // in user mode; the null-user one DOES count in day mode (matches the API).
  ev('', 'email_sent', DAY_A),
  ev('u1', 'lead_created', DAY_A),
];

const HAND_CALLS: CallSeed[] = [
  { userId: 'u1', startedAt: DAY_A, durationS: 420 },
  { userId: 'u1', startedAt: DAY_A, durationS: 420 },
  { userId: 'u1', startedAt: DAY_A, durationS: 300 },
  { userId: 'u1', startedAt: DAY_B, durationS: 30 },
];

const HAND_REPS = [{ id: 'u1' }, { id: 'u2' }, { id: 'uZ' }];

function byBucket(rows: ActivityReportRow[]): Map<string, ActivityReportRow> {
  return new Map(rows.map((r) => [r.bucket, r]));
}

describe('aggregateActivity — semantics', () => {
  test('user mode: exact per-rep counts, outcomes, and talk time', () => {
    const rows = aggregateActivity({
      events: HAND_EVENTS,
      calls: HAND_CALLS,
      reps: HAND_REPS,
      from: '2026-07-14',
      to: '2026-07-15',
    });
    // sorted by bucket asc; the null-user + lead_created rows are excluded.
    expect(rows.map((r) => r.bucket)).toEqual(['u1', 'u2']);
    const m = byBucket(rows);
    const u1 = m.get('u1');
    expect(u1).toEqual<ActivityReportRow>({
      bucket: 'u1',
      callsLogged: 4,
      callsInbound: 1,
      callsOutbound: 3,
      callsByOutcome: { connected: 3, voicemail: 1 },
      callsMissed: 1,
      voicemails: 1,
      emailsSent: 4,
      emailsReceived: 2,
      smsSent: 1,
      smsReceived: 1,
      notesAdded: 1,
      tasksCompleted: 1,
      talkTimeSeconds: 1170,
    });
    expect(m.get('u2')?.emailsSent).toBe(5);
    expect(m.get('u2')?.talkTimeSeconds).toBe(0);
  });

  test('a narrower range genuinely re-queries (fewer events, fewer buckets)', () => {
    const rows = aggregateActivity({
      events: HAND_EVENTS,
      calls: HAND_CALLS,
      reps: HAND_REPS,
      from: '2026-07-14',
      to: '2026-07-14',
    });
    // Only day B has data → u2 (day-A only) drops out entirely.
    expect(rows.map((r) => r.bucket)).toEqual(['u1']);
    const u1 = byBucket(rows).get('u1');
    expect(u1?.callsLogged).toBe(1);
    expect(u1?.callsByOutcome).toEqual({ voicemail: 1 });
    expect(u1?.emailsSent).toBe(1);
    expect(u1?.talkTimeSeconds).toBe(30);
  });

  test('a userId filter with no activity in range still returns a zero-row', () => {
    const rows = aggregateActivity({
      events: HAND_EVENTS,
      calls: HAND_CALLS,
      reps: HAND_REPS,
      from: '2026-07-14',
      to: '2026-07-14',
      userId: 'uZ',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bucket).toBe('uZ');
    expect(rows[0]?.callsLogged).toBe(0);
    expect(rows[0]?.emailsSent).toBe(0);
    expect(rows[0]?.talkTimeSeconds).toBe(0);
  });

  test('day mode buckets by UTC day and includes unattributed events', () => {
    const rows = aggregateActivity({
      events: HAND_EVENTS,
      calls: HAND_CALLS,
      reps: HAND_REPS,
      from: '2026-07-14',
      to: '2026-07-15',
      groupBy: 'day',
    });
    expect(rows.map((r) => r.bucket)).toEqual(['2026-07-14', '2026-07-15']);
    const m = byBucket(rows);
    // day A emails: u1(3) + u2(5) + null-user(1) = 9
    expect(m.get('2026-07-15')?.emailsSent).toBe(9);
    expect(m.get('2026-07-14')?.emailsSent).toBe(1);
    expect(m.get('2026-07-15')?.talkTimeSeconds).toBe(1140);
  });
});

describe('sumActivityRows', () => {
  test('org totals reconcile with the per-rep rows', () => {
    const rows = aggregateActivity({
      events: HAND_EVENTS,
      calls: HAND_CALLS,
      reps: HAND_REPS,
      from: '2026-07-14',
      to: '2026-07-15',
    });
    const total = sumActivityRows(rows);
    expect(total.emailsSent).toBe(9); // u1(4) + u2(5)
    expect(total.callsLogged).toBe(4);
    expect(total.talkTimeSeconds).toBe(1170);
    expect(total.callsByOutcome).toEqual({ connected: 3, voicemail: 1 });
  });
});

// ── Funnel: exact math on a small hand fixture ───────────────────────────────

const F_STAGES = [
  { id: 's0', label: 'Discovery', sortOrder: 0 },
  { id: 's1', label: 'Proposal', sortOrder: 1 },
  { id: 'sw', label: 'Closed Won', sortOrder: 2 },
  { id: 'sl', label: 'Closed Lost', sortOrder: 3 },
];

function opp(o: Partial<FunnelOppSeed> & Pick<FunnelOppSeed, 'currency' | 'stageId' | 'status'>): FunnelOppSeed {
  return {
    id: `${o.currency}-${o.stageId}-${Math.random()}`,
    valueCents: 0,
    confidence: 0,
    closeDate: '2026-07-10',
    ...o,
  };
}

const F_OPPS: FunnelOppSeed[] = [
  opp({ currency: 'USD', stageId: 's0', status: 'active', valueCents: 100_000, confidence: 50 }),
  opp({ currency: 'USD', stageId: 's0', status: 'active', valueCents: 100_000, confidence: 50 }),
  opp({ currency: 'USD', stageId: 's1', status: 'active', valueCents: 500_000, confidence: 40 }),
  opp({ currency: 'USD', stageId: 'sw', status: 'won', valueCents: 300_000, closeDate: '2026-07-10' }),
  opp({ currency: 'USD', stageId: 'sw', status: 'won', valueCents: 300_000, closeDate: '2026-07-01' }),
  opp({ currency: 'USD', stageId: 'sl', status: 'lost', valueCents: 200_000, closeDate: '2026-06-20' }),
  opp({ currency: 'EUR', stageId: 's0', status: 'active', valueCents: 100_000, confidence: 30 }),
];

const F_CHANGES: StageChangeSeed[] = [
  { opportunityId: 'x', currency: 'USD', from: 's0', to: 's1', occurredAt: '2026-07-08T12:00:00Z' },
  { opportunityId: 'x', currency: 'USD', from: 's0', to: 's1', occurredAt: '2026-07-08T12:00:00Z' },
  { opportunityId: 'x', currency: 'USD', from: 's1', to: 'sw', occurredAt: '2026-07-08T12:00:00Z' },
];

function cell(rows: FunnelStageRow[], currency: string, stageId: string): FunnelStageRow | undefined {
  return rows.find((r) => r.currency === currency && r.stageId === stageId);
}

describe('aggregateFunnel — semantics', () => {
  test('all-time: open snapshot, won/lost, entered/exited; currencies never sum', () => {
    const rows = aggregateFunnel({ opps: F_OPPS, stageChanges: F_CHANGES, stages: F_STAGES });
    // ordering: currency asc (EUR before USD), then stage sort order.
    expect(rows.map((r) => `${r.currency}:${r.stageId}`)).toEqual([
      'EUR:s0',
      'USD:s0',
      'USD:s1',
      'USD:sw',
      'USD:sl',
    ]);

    const usdS0 = cell(rows, 'USD', 's0');
    expect(usdS0).toMatchObject({
      openCount: 2,
      openValueCents: 200_000,
      openWeightedValueCents: 100_000, // 100000*50/100 * 2
      wonCount: 0,
      lostCount: 0,
      enteredCount: 0,
      exitedCount: 2,
    });

    expect(cell(rows, 'USD', 's1')).toMatchObject({
      openCount: 1,
      openValueCents: 500_000,
      openWeightedValueCents: 200_000, // 500000*40/100
      enteredCount: 2,
      exitedCount: 1,
    });

    expect(cell(rows, 'USD', 'sw')).toMatchObject({
      openCount: 0,
      wonCount: 2,
      wonValueCents: 600_000,
      enteredCount: 1,
    });

    expect(cell(rows, 'USD', 'sl')).toMatchObject({ lostCount: 1, lostValueCents: 200_000 });

    expect(cell(rows, 'EUR', 's0')).toMatchObject({
      openCount: 1,
      openWeightedValueCents: 30_000, // 100000*30/100
    });
  });

  test('weighted value rounds the SUM (not per-row) to whole cents', () => {
    const rows = aggregateFunnel({
      opps: [
        opp({ currency: 'USD', stageId: 's0', status: 'active', valueCents: 101, confidence: 33 }),
        opp({ currency: 'USD', stageId: 's0', status: 'active', valueCents: 101, confidence: 34 }),
      ],
      stageChanges: [],
      stages: F_STAGES,
    });
    // (101*33/100 = 33.33) + (101*34/100 = 34.34) = 67.67 → round → 68
    expect(cell(rows, 'USD', 's0')?.openWeightedValueCents).toBe(68);
  });

  test('a range scopes won/lost by close date (open stays a live snapshot)', () => {
    const rows = aggregateFunnel({
      opps: F_OPPS,
      stageChanges: F_CHANGES,
      stages: F_STAGES,
      from: '2026-07-05',
      to: '2026-07-15',
    });
    // won closeDate 2026-07-10 in-range, 2026-07-01 out → 1. The lost cell still
    // exists (the stage has an opp) but its out-of-range close zeroes the count —
    // matching the API's GROUP BY (currency, stage) with close date only a FILTER.
    expect(cell(rows, 'USD', 'sw')?.wonCount).toBe(1);
    expect(cell(rows, 'USD', 'sl')?.lostCount).toBe(0);
    // open snapshot is unaffected by the range.
    expect(cell(rows, 'USD', 's0')?.openCount).toBe(2);
  });

  test('a currency filter isolates one currency', () => {
    const rows = aggregateFunnel({
      opps: F_OPPS,
      stageChanges: F_CHANGES,
      stages: F_STAGES,
      currency: 'EUR',
    });
    expect(rows.every((r) => r.currency === 'EUR')).toBe(true);
    expect(rows).toHaveLength(1);
  });
});

// ── Sequences: exact math on a small hand fixture ────────────────────────────

const S_SEQS: SequenceSeed[] = [
  { id: 'sa', name: 'Alpha', status: 'active' },
  { id: 'sb', name: 'Beta', status: 'archived' },
  { id: 'sc', name: 'Gamma', status: 'active' },
];

const S_ENROLL: EnrollmentSeed[] = [
  { id: 'ea', sequenceId: 'sa', state: 'active' },
  { id: 'ea2', sequenceId: 'sa', state: 'active' },
  { id: 'ea3', sequenceId: 'sa', state: 'active' },
  { id: 'ap', sequenceId: 'sa', state: 'paused' },
  { id: 'eb', sequenceId: 'sb', state: 'active' },
  { id: 'bp', sequenceId: 'sb', state: 'paused' },
  { id: 'bp2', sequenceId: 'sb', state: 'paused' },
];

const IN = '2026-07-15T10:00:00Z';
const OUT = '2026-01-01T10:00:00Z';

function seqEvents(): SequenceEventSeed[] {
  const out: SequenceEventSeed[] = [];
  const push = (
    enrollmentId: string,
    type: SequenceEventSeed['type'],
    count: number,
    occurredAt: string,
    reason?: SequenceEventSeed['reason'],
  ): void => {
    for (let k = 0; k < count; k += 1) {
      out.push(reason ? { enrollmentId, type, reason, occurredAt } : { enrollmentId, type, occurredAt });
    }
  };
  // Alpha (all in-range)
  push('ea', 'sequence_step_sent', 10, IN);
  push('ea', 'sequence_paused', 3, IN, 'reply');
  push('ea', 'sequence_paused', 1, IN, 'bounce');
  push('ea', 'sequence_paused', 1, IN, 'unsubscribe');
  push('ea', 'sequence_paused', 1, IN, 'manual'); // ignored by the report
  push('ea', 'sequence_finished', 2, IN);
  // Beta: 4 sends in-range + 2 sends out-of-range, 2 bounces, 1 finish
  push('eb', 'sequence_step_sent', 4, IN);
  push('eb', 'sequence_step_sent', 2, OUT);
  push('eb', 'sequence_paused', 2, IN, 'bounce');
  push('eb', 'sequence_finished', 1, IN);
  return out;
}

function seqByName(rows: SequenceReportRow[]): Map<string, SequenceReportRow> {
  return new Map(rows.map((r) => [r.sequenceName, r]));
}

describe('aggregateSequences — semantics', () => {
  test('all-time: exact counts; manual pauses ignored; zero-activity anchored', () => {
    const rows = aggregateSequences({
      sequences: S_SEQS,
      enrollments: S_ENROLL,
      events: seqEvents(),
    });
    expect(rows.map((r) => r.sequenceName)).toEqual(['Alpha', 'Beta', 'Gamma']);
    const m = seqByName(rows);
    expect(m.get('Alpha')).toEqual<SequenceReportRow>({
      sequenceId: 'sa',
      sequenceName: 'Alpha',
      sequenceStatus: 'active',
      sends: 10,
      replies: 3,
      bounces: 1,
      unsubscribes: 1,
      finishes: 2,
      activeEnrollments: 3,
      pausedEnrollments: 1,
    });
    expect(m.get('Beta')).toMatchObject({
      sequenceStatus: 'archived',
      sends: 6,
      bounces: 2,
      finishes: 1,
      activeEnrollments: 1,
      pausedEnrollments: 2,
    });
    // zero-activity sequence still returns an all-zero row.
    expect(m.get('Gamma')).toMatchObject({ sends: 0, activeEnrollments: 0, pausedEnrollments: 0 });
  });

  test('a range scopes the event counts', () => {
    const rows = aggregateSequences({
      sequences: S_SEQS,
      enrollments: S_ENROLL,
      events: seqEvents(),
      from: '2026-07-01',
      to: '2026-07-31',
    });
    // Beta's 2 out-of-range sends drop out → 4.
    expect(seqByName(rows).get('Beta')?.sends).toBe(4);
  });

  test('a sequenceId filter isolates one sequence', () => {
    const rows = aggregateSequences({
      sequences: S_SEQS,
      enrollments: S_ENROLL,
      events: seqEvents(),
      sequenceId: 'sb',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sequenceName).toBe('Beta');
  });
});

// ── Exact-by-construction assertions against the real demo seed ──────────────

describe('the demo seed aggregates to its constructed totals', () => {
  const full = presetRange(90);

  test('activity: 90-day per-rep totals equal window × daily profile', () => {
    const rows = aggregateActivity({
      events: reportSeed.activityEvents,
      calls: reportSeed.calls,
      reps: reportSeed.reps,
      from: full.from,
      to: full.to,
    });
    expect(rows).toHaveLength(reportSeed.reps.length);
    const m = byBucket(rows);

    reportSeed.reps.forEach((rep, i) => {
      const p = profileFor(i);
      const row = m.get(rep.id);
      expect(row, `row for rep ${i}`).toBeDefined();
      if (!row) return;
      expect(row.callsLogged).toBe(WINDOW_DAYS * dailyCallsLogged(p));
      expect(row.callsInbound).toBe(WINDOW_DAYS * p.callsIn);
      expect(row.callsOutbound).toBe(WINDOW_DAYS * p.callsOut);
      expect(row.emailsSent).toBe(WINDOW_DAYS * p.emailsOut);
      expect(row.emailsReceived).toBe(WINDOW_DAYS * p.emailsIn);
      expect(row.smsSent).toBe(WINDOW_DAYS * p.smsOut);
      expect(row.smsReceived).toBe(WINDOW_DAYS * p.smsIn);
      expect(row.notesAdded).toBe(WINDOW_DAYS * p.notes);
      expect(row.tasksCompleted).toBe(WINDOW_DAYS * p.tasks);
      expect(row.callsMissed).toBe(WINDOW_DAYS * p.callsMissed);
      expect(row.voicemails).toBe(WINDOW_DAYS * p.voicemails);
      expect(row.talkTimeSeconds).toBe(WINDOW_DAYS * dailyTalkSeconds(p));
      // callsByOutcome sums back to callsLogged.
      const outcomeSum = Object.values(row.callsByOutcome).reduce((a, b) => a + b, 0);
      expect(outcomeSum).toBe(row.callsLogged);
    });
  });

  test('activity: exact "connected" outcome count for the lead rep', () => {
    const p0 = REP_PROFILES[0];
    if (!p0) throw new Error('need a profile');
    let connectedPerDay = p0.callsIn; // inbound are all "connected"
    for (let k = 0; k < p0.callsOut; k += 1) {
      if (OUT_OUTCOMES[k % OUT_OUTCOMES.length] === 'connected') connectedPerDay += 1;
    }
    const rows = aggregateActivity({
      events: reportSeed.activityEvents,
      calls: reportSeed.calls,
      reps: reportSeed.reps,
      from: full.from,
      to: full.to,
    });
    const leadRepId = reportSeed.reps[0]?.id ?? '';
    expect(byBucket(rows).get(leadRepId)?.callsByOutcome.connected).toBe(
      WINDOW_DAYS * connectedPerDay,
    );
  });

  test('activity: a narrower range re-queries to strictly smaller totals', () => {
    const args = {
      events: reportSeed.activityEvents,
      calls: reportSeed.calls,
      reps: reportSeed.reps,
    };
    const wk = presetRange(7);
    const mo = presetRange(30);
    const total = (from: string, to: string): number =>
      sumActivityRows(aggregateActivity({ ...args, from, to })).callsLogged;
    const week = total(wk.from, wk.to);
    const month = total(mo.from, mo.to);
    const quarter = total(full.from, full.to);
    expect(week).toBeLessThan(month);
    expect(month).toBeLessThan(quarter);
    // 7-day is exactly 7 × the summed daily rate.
    const dailyOrg = REP_PROFILES.slice(0, reportSeed.reps.length).reduce(
      (a, p) => a + dailyCallsLogged(p),
      0,
    );
    expect(week).toBe(7 * dailyOrg);
  });

  test('funnel: per-stage open/won/lost counts match FUNNEL_COUNTS; currencies present', () => {
    const rows = aggregateFunnel({
      opps: reportSeed.funnelOpps,
      stageChanges: reportSeed.stageChanges,
      stages: reportSeed.stages,
    });
    const ordered = [...reportSeed.stages].sort((a, b) => a.sortOrder - b.sortOrder);
    for (const currency of CURRENCIES) {
      const counts = FUNNEL_COUNTS[currency] ?? [];
      ordered.forEach((stage, i) => {
        const row = cell(rows, currency, stage.id);
        expect(row, `${currency} ${stage.label}`).toBeDefined();
        if (!row) return;
        const kind = stageKind(stage.label);
        if (kind === 'open') {
          expect(row.openCount).toBe(counts[i] ?? 0);
          expect(row.openWeightedValueCents).toBeLessThanOrEqual(row.openValueCents);
        } else if (kind === 'won') {
          expect(row.wonCount).toBe(counts[i] ?? 0);
        } else {
          expect(row.lostCount).toBe(counts[i] ?? 0);
        }
      });
    }
    // entered/exited totals per USD stage-change plan (3+2+1).
    const usd = rows.filter((r) => r.currency === 'USD');
    expect(usd.reduce((a, r) => a + r.enteredCount, 0)).toBe(6);
    expect(usd.reduce((a, r) => a + r.exitedCount, 0)).toBe(6);
    expect(new Set(rows.map((r) => r.currency))).toEqual(new Set(['USD', 'EUR']));
  });

  test('sequences: each row matches its explicit spec', () => {
    const rows = aggregateSequences({
      sequences: reportSeed.sequences,
      enrollments: reportSeed.enrollments,
      events: reportSeed.sequenceEvents,
    });
    const m = seqByName(rows);
    for (const spec of SEQ_SPEC) {
      const row = m.get(spec.name);
      expect(row, spec.name).toBeDefined();
      if (!row) continue;
      expect(row.sends).toBe(spec.sends);
      expect(row.replies).toBe(spec.replies);
      expect(row.bounces).toBe(spec.bounces);
      expect(row.unsubscribes).toBe(spec.unsubscribes);
      expect(row.finishes).toBe(spec.finishes);
      expect(row.activeEnrollments).toBe(spec.active);
      expect(row.pausedEnrollments).toBe(spec.paused);
    }
    // the archived, zero-send sequence is still present (anchored on sequences).
    expect(m.get('Win-back')?.sends).toBe(0);
  });
});
