import { describe, expect, test } from 'vitest';
import {
  buildQueue,
  computeStats,
  countDoneToday,
  type OpenSnapshot,
  type ReplyRow,
  type ReviewRow,
  type TaskRow,
} from './model.ts';

/**
 * Pure merge/sort/stats math (CONTRACTS §C7 D-030), mirroring the web
 * `features/inbox/model/queue.ts`. Anchored to a fixed clock so ordering, the
 * overdue flag, and the counters are exhaustively and deterministically checked.
 */

const NOW = Date.parse('2026-07-15T17:00:00.000Z');
// startOfToday = 2026-07-15T00:00Z ; startOfTomorrow = 2026-07-16T00:00Z

function task(over: Partial<TaskRow> & Pick<TaskRow, 'taskId' | 'dueAt'>): TaskRow {
  return {
    leadId: 'L1',
    leadName: 'Acme',
    title: 'Follow up',
    completedAt: null,
    leadDnc: false,
    ...over,
  };
}
function reply(over: Partial<ReplyRow> & Pick<ReplyRow, 'threadId' | 'receivedAt'>): ReplyRow {
  return {
    leadId: 'L1',
    leadName: 'Acme',
    contactId: 'C1',
    contactName: 'Dana',
    toAddress: 'dana@acme.test',
    subject: 'Re: hi',
    snippet: 'thanks',
    lastContactedAt: null,
    ...over,
  };
}
function review(over: Partial<ReviewRow> & Pick<ReviewRow, 'intentId' | 'dueAt'>): ReviewRow {
  return {
    enrollmentId: 'E1',
    leadId: 'L1',
    leadName: 'Acme',
    contactName: 'Dana',
    sequenceName: 'Onboarding',
    stepIndex: 2,
    stepCount: 4,
    channel: 'email',
    subject: 'Step 2',
    preview: 'hello',
    state: 'AWAITING_REVIEW',
    ...over,
  };
}

const empty: OpenSnapshot = { tasks: [], replies: [], reviews: [] };

describe('buildQueue ordering', () => {
  test('sections in order: tasks → replies → reviews', () => {
    const open: OpenSnapshot = {
      tasks: [task({ taskId: 'T1', dueAt: '2026-07-14T09:00:00.000Z' })],
      replies: [reply({ threadId: 'TH1', receivedAt: '2026-07-15T16:00:00.000Z' })],
      reviews: [review({ intentId: 'I1', dueAt: '2026-07-15T12:00:00.000Z' })],
    };
    const q = buildQueue(open, NOW);
    expect(q.map((i) => i.kind)).toEqual(['task', 'reply', 'review']);
    expect(q.map((i) => i.id)).toEqual(['task:T1', 'reply:TH1', 'review:I1']);
  });

  test('tasks sort by dueAt asc, tie-break by id', () => {
    const open: OpenSnapshot = {
      ...empty,
      tasks: [
        task({ taskId: 'Tb', dueAt: '2026-07-15T09:00:00.000Z' }),
        task({ taskId: 'Ta', dueAt: '2026-07-14T09:00:00.000Z' }),
        task({ taskId: 'Tc', dueAt: '2026-07-15T09:00:00.000Z' }),
      ],
    };
    // Ta earliest; Tb & Tc share dueAt → tie-break by composite id (task:Tb < task:Tc).
    expect(buildQueue(open, NOW).map((i) => i.id)).toEqual(['task:Ta', 'task:Tb', 'task:Tc']);
  });

  test('replies sort by receivedAt DESC (newest first), tie-break by id', () => {
    const open: OpenSnapshot = {
      ...empty,
      replies: [
        reply({ threadId: 'Rold', receivedAt: '2026-07-15T10:00:00.000Z' }),
        reply({ threadId: 'Rb', receivedAt: '2026-07-15T16:00:00.000Z' }),
        reply({ threadId: 'Ra', receivedAt: '2026-07-15T16:00:00.000Z' }),
      ],
    };
    expect(buildQueue(open, NOW).map((i) => i.id)).toEqual(['reply:Ra', 'reply:Rb', 'reply:Rold']);
  });

  test('reviews sort by dueAt ASC (longest-waiting first)', () => {
    const open: OpenSnapshot = {
      ...empty,
      reviews: [
        review({ intentId: 'Inew', dueAt: '2026-07-15T14:00:00.000Z' }),
        review({ intentId: 'Iold', dueAt: '2026-07-15T09:00:00.000Z' }),
      ],
    };
    expect(buildQueue(open, NOW).map((i) => i.id)).toEqual(['review:Iold', 'review:Inew']);
  });
});

describe('buildQueue filters', () => {
  test('completed / future / due tasks', () => {
    const open: OpenSnapshot = {
      ...empty,
      tasks: [
        task({
          taskId: 'Tdone',
          dueAt: '2026-07-14T09:00:00.000Z',
          completedAt: '2026-07-15T01:00:00.000Z',
        }),
        task({ taskId: 'Tfuture', dueAt: '2026-07-16T09:00:00.000Z' }),
        task({ taskId: 'Tnull', dueAt: null }),
        task({ taskId: 'Tdue', dueAt: '2026-07-15T09:00:00.000Z' }),
      ],
    };
    expect(buildQueue(open, NOW).map((i) => i.id)).toEqual(['task:Tdue']);
  });

  test('answered reply excluded (receivedAt <= lastContactedAt)', () => {
    const open: OpenSnapshot = {
      ...empty,
      replies: [
        reply({
          threadId: 'answered',
          receivedAt: '2026-07-15T10:00:00.000Z',
          lastContactedAt: '2026-07-15T11:00:00.000Z',
        }),
        reply({ threadId: 'open', receivedAt: '2026-07-15T12:00:00.000Z' }),
      ],
    };
    expect(buildQueue(open, NOW).map((i) => i.id)).toEqual(['reply:open']);
  });

  test('non-AWAITING_REVIEW review excluded', () => {
    const open: OpenSnapshot = {
      ...empty,
      reviews: [
        review({ intentId: 'sent', dueAt: '2026-07-15T09:00:00.000Z', state: 'SENT' }),
        review({ intentId: 'live', dueAt: '2026-07-15T10:00:00.000Z' }),
      ],
    };
    expect(buildQueue(open, NOW).map((i) => i.id)).toEqual(['review:live']);
  });
});

describe('item fields', () => {
  test('task overdue flag: before start-of-today → true; earlier today → false', () => {
    const open: OpenSnapshot = {
      ...empty,
      tasks: [
        task({ taskId: 'Tover', dueAt: '2026-07-14T23:59:00.000Z' }),
        task({ taskId: 'Ttoday', dueAt: '2026-07-15T09:00:00.000Z' }),
      ],
    };
    const items = buildQueue(open, NOW);
    const over = items.find((i) => i.id === 'task:Tover');
    const today = items.find((i) => i.id === 'task:Ttoday');
    expect(over && 'overdue' in over && over.overdue).toBe(true);
    expect(today && 'overdue' in today && today.overdue).toBe(false);
  });

  test('review stepLabel + channel label', () => {
    const q = buildQueue(
      {
        ...empty,
        reviews: [
          review({
            intentId: 'I1',
            dueAt: NOW.toString(),
            channel: 'sms',
            stepIndex: 3,
            stepCount: 5,
          }),
        ],
      },
      NOW,
    );
    const item = q[0];
    expect(item && 'stepLabel' in item && item.stepLabel).toBe('Step 3 of 5 · SMS');
  });
});

describe('computeStats', () => {
  test('needsYouNow = total items; overdue = task count', () => {
    const open: OpenSnapshot = {
      tasks: [
        task({ taskId: 'T1', dueAt: '2026-07-14T09:00:00.000Z' }),
        task({ taskId: 'T2', dueAt: '2026-07-15T09:00:00.000Z' }),
      ],
      replies: [reply({ threadId: 'R1', receivedAt: '2026-07-15T16:00:00.000Z' })],
      reviews: [review({ intentId: 'I1', dueAt: '2026-07-15T12:00:00.000Z' })],
    };
    const stats = computeStats(open, [], NOW);
    expect(stats).toEqual({ needsYouNow: 4, overdue: 2, doneToday: 0 });
  });
});

describe('countDoneToday boundaries', () => {
  test('start-of-today inclusive; start-of-tomorrow exclusive; nulls skipped', () => {
    const done = [
      { at: '2026-07-14T23:59:59.999Z' }, // yesterday → out
      { at: '2026-07-15T00:00:00.000Z' }, // start of today → in
      { at: '2026-07-15T23:59:59.999Z' }, // late today → in
      { at: '2026-07-16T00:00:00.000Z' }, // start of tomorrow → out
      { at: null }, // no timestamp → out
    ];
    expect(countDoneToday(done, NOW)).toBe(2);
  });
});
