/*
 * Org-total roll-up over activity rows — the stat-tile source. Pure and
 * mock-free so components can import it without pulling the MSW seed into the
 * real-mode bundle.
 */
import type { ActivityReportRow } from '../types.ts';

export function emptyActivityRow(bucket: string): ActivityReportRow {
  return {
    bucket,
    callsLogged: 0,
    callsInbound: 0,
    callsOutbound: 0,
    callsByOutcome: {},
    callsMissed: 0,
    voicemails: 0,
    emailsSent: 0,
    emailsReceived: 0,
    smsSent: 0,
    smsReceived: 0,
    notesAdded: 0,
    tasksCompleted: 0,
    talkTimeSeconds: 0,
  };
}

/** Sum every metric across rows (the org totals behind the activity stat tiles). */
export function sumActivityRows(rows: readonly ActivityReportRow[]): ActivityReportRow {
  const total = emptyActivityRow('__total__');
  for (const r of rows) {
    total.callsLogged += r.callsLogged;
    total.callsInbound += r.callsInbound;
    total.callsOutbound += r.callsOutbound;
    total.callsMissed += r.callsMissed;
    total.voicemails += r.voicemails;
    total.emailsSent += r.emailsSent;
    total.emailsReceived += r.emailsReceived;
    total.smsSent += r.smsSent;
    total.smsReceived += r.smsReceived;
    total.notesAdded += r.notesAdded;
    total.tasksCompleted += r.tasksCompleted;
    total.talkTimeSeconds += r.talkTimeSeconds;
    for (const [k, v] of Object.entries(r.callsByOutcome)) {
      total.callsByOutcome[k] = (total.callsByOutcome[k] ?? 0) + v;
    }
  }
  return total;
}
