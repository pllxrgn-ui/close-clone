import { describe, expect, test } from 'vitest';
import {
  buildQueue,
  computeStats,
  countDoneToday,
  groupSections,
  nextTaskDueFor,
} from './queue.ts';
import { INBOX_NOW_MS } from './time.ts';
import type { InboxStoreData, StoredReview, StoredTask, StoredThread } from './store.ts';

const NOW = INBOX_NOW_MS;
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW + ms).toISOString();

function store(partial: Partial<InboxStoreData> = {}): InboxStoreData {
  return {
    threads: partial.threads ?? new Map(),
    tasks: partial.tasks ?? new Map(),
    reviews: partial.reviews ?? new Map(),
    leadNames: partial.leadNames ?? new Map(),
    leadDnc: partial.leadDnc ?? new Map(),
  };
}

function thread(over: Partial<StoredThread> & { id: string; leadId: string }): StoredThread {
  return {
    contactId: null,
    contactName: 'Sam Patel',
    channel: 'email',
    toAddress: 'sam@acme.test',
    subject: 'Re: pilot',
    snippet: 'Looks good, two questions…',
    lastInboundAt: ago(2 * H),
    lastContactedAt: ago(3 * D),
    answered: false,
    answeredAt: null,
    snoozedUntil: null,
    messages: [],
    ...over,
  };
}

function task(over: Partial<StoredTask> & { id: string; leadId: string }): StoredTask {
  return {
    title: 'Follow up on pricing',
    dueAt: ago(2 * D),
    completedAt: null,
    snoozedUntil: null,
    ...over,
  };
}

function review(over: Partial<StoredReview> & { id: string; leadId: string }): StoredReview {
  return {
    enrollmentId: 'en1',
    stepId: 'sp1',
    sequenceId: 'sq1',
    contactId: null,
    contactName: 'Sam Patel',
    sequenceName: 'Onboarding',
    stepIndex: 2,
    stepCount: 4,
    channel: 'email',
    subject: 'A quick idea',
    preview: 'Hi Sam…',
    dueAt: ago(5 * H),
    state: 'AWAITING_REVIEW',
    disposition: null,
    dispositionedAt: null,
    snoozedUntil: null,
    ...over,
  };
}

function names(...pairs: Array<[string, string]>): Map<string, string> {
  return new Map(pairs);
}

describe('buildQueue — merge + ordering', () => {
  test('sections in order: overdue tasks, then replies by recency, then reviews', () => {
    const data = store({
      tasks: new Map([
        ['t-old', task({ id: 't-old', leadId: 'L1', dueAt: ago(3 * D) })],
        ['t-new', task({ id: 't-new', leadId: 'L2', dueAt: ago(4 * H) })],
      ]),
      threads: new Map([
        ['r-old', thread({ id: 'r-old', leadId: 'L3', lastInboundAt: ago(6 * H) })],
        ['r-new', thread({ id: 'r-new', leadId: 'L4', lastInboundAt: ago(1 * H) })],
      ]),
      reviews: new Map([
        ['v-old', review({ id: 'v-old', leadId: 'L5', dueAt: ago(10 * H) })],
        ['v-new', review({ id: 'v-new', leadId: 'L6', dueAt: ago(1 * H) })],
      ]),
    });

    const q = buildQueue(data, NOW);
    expect(q.map((i) => i.kind)).toEqual(['task', 'task', 'reply', 'reply', 'review', 'review']);
    // tasks: most overdue (oldest due) first
    expect(q[0]?.id).toBe('task:t-old');
    expect(q[1]?.id).toBe('task:t-new');
    // replies: newest inbound first
    expect(q[2]?.id).toBe('reply:r-new');
    expect(q[3]?.id).toBe('reply:r-old');
    // reviews: longest-waiting (oldest due) first
    expect(q[4]?.id).toBe('review:v-old');
    expect(q[5]?.id).toBe('review:v-new');
  });

  test('excludes answered / completed / future / snoozed / non-awaiting', () => {
    const data = store({
      threads: new Map([
        ['answered', thread({ id: 'answered', leadId: 'L1', answered: true })],
        ['snoozed', thread({ id: 'snoozed', leadId: 'L2', snoozedUntil: ahead(6 * H) })],
        [
          'stale',
          // last contact AFTER the inbound → nothing to answer
          thread({
            id: 'stale',
            leadId: 'L3',
            lastInboundAt: ago(3 * D),
            lastContactedAt: ago(1 * H),
          }),
        ],
        ['open', thread({ id: 'open', leadId: 'L4' })],
      ]),
      tasks: new Map([
        ['done', task({ id: 'done', leadId: 'L5', completedAt: ago(1 * H) })],
        ['future', task({ id: 'future', leadId: 'L6', dueAt: ahead(2 * D) })],
        ['due', task({ id: 'due', leadId: 'L7' })],
      ]),
      reviews: new Map([
        ['sent', review({ id: 'sent', leadId: 'L8', state: 'SENT' })],
        ['await', review({ id: 'await', leadId: 'L9' })],
      ]),
    });

    const ids = buildQueue(data, NOW).map((i) => i.id);
    expect(ids).toContain('reply:open');
    expect(ids).toContain('task:due');
    expect(ids).toContain('review:await');
    expect(ids).not.toContain('reply:answered');
    expect(ids).not.toContain('reply:snoozed');
    expect(ids).not.toContain('reply:stale');
    expect(ids).not.toContain('task:done');
    expect(ids).not.toContain('task:future');
    expect(ids).not.toContain('review:sent');
  });

  test('a snoozed item whose snooze has expired is open again', () => {
    const data = store({
      tasks: new Map([['t', task({ id: 't', leadId: 'L1', snoozedUntil: ago(1 * H) })]]),
    });
    expect(buildQueue(data, NOW).map((i) => i.id)).toEqual(['task:t']);
  });

  test('reply with no prior contact (lastContactedAt null) is open', () => {
    const data = store({
      threads: new Map([
        ['t', thread({ id: 't', leadId: 'L1', lastContactedAt: null, lastInboundAt: ago(1 * H) })],
      ]),
    });
    expect(buildQueue(data, NOW).map((i) => i.id)).toEqual(['reply:t']);
  });

  test('task overdue flag: earlier-day = overdue, earlier-today = not overdue', () => {
    const data = store({
      tasks: new Map([
        ['yesterday', task({ id: 'yesterday', leadId: 'L1', dueAt: ago(2 * D) })],
        ['today', task({ id: 'today', leadId: 'L2', dueAt: ago(3 * H) })],
      ]),
    });
    const byId = new Map(buildQueue(data, NOW).map((i) => [i.id, i]));
    const y = byId.get('task:yesterday');
    const t = byId.get('task:today');
    expect(y?.kind === 'task' && y.overdue).toBe(true);
    expect(t?.kind === 'task' && t.overdue).toBe(false);
  });

  test('resolves lead names and surfaces DNC on task rows', () => {
    const data = store({
      tasks: new Map([['t', task({ id: 't', leadId: 'L1' })]]),
      leadNames: names(['L1', 'North Labs']),
      leadDnc: new Map([['L1', true]]),
    });
    const item = buildQueue(data, NOW)[0];
    expect(item?.leadName).toBe('North Labs');
    expect(item?.kind === 'task' && item.leadDnc).toBe(true);
  });
});

describe('groupSections', () => {
  test('labels + counts, order preserved, empties dropped', () => {
    const data = store({
      tasks: new Map([['t', task({ id: 't', leadId: 'L1' })]]),
      reviews: new Map([['v', review({ id: 'v', leadId: 'L2' })]]),
    });
    const sections = groupSections(buildQueue(data, NOW));
    expect(sections.map((s) => s.id)).toEqual(['overdue', 'reviews']); // no replies → dropped
    expect(sections.map((s) => s.label)).toEqual(['Overdue', 'Review']);
    expect(sections[0]?.items).toHaveLength(1);
    expect(sections[1]?.items).toHaveLength(1);
  });
});

describe('computeStats + countDoneToday', () => {
  test('needsYouNow = queue length, overdue = task count', () => {
    const data = store({
      tasks: new Map([
        ['t1', task({ id: 't1', leadId: 'L1' })],
        ['t2', task({ id: 't2', leadId: 'L2', dueAt: ago(3 * H) })],
      ]),
      threads: new Map([['r', thread({ id: 'r', leadId: 'L3' })]]),
    });
    const stats = computeStats(data, NOW);
    expect(stats.needsYouNow).toBe(3);
    expect(stats.overdue).toBe(2);
  });

  test('doneToday counts today-completed tasks, answered threads, dispositioned reviews', () => {
    const data = store({
      tasks: new Map([
        ['today', task({ id: 'today', leadId: 'L1', completedAt: ago(2 * H) })],
        ['yesterday', task({ id: 'yesterday', leadId: 'L2', completedAt: ago(30 * H) })],
      ]),
      threads: new Map([
        ['ans', thread({ id: 'ans', leadId: 'L3', answered: true, answeredAt: ago(1 * H) })],
      ]),
      reviews: new Map([
        ['sent', review({ id: 'sent', leadId: 'L4', state: 'SENT', dispositionedAt: ago(1 * H) })],
        [
          'skip',
          review({ id: 'skip', leadId: 'L5', state: 'SKIPPED', dispositionedAt: ago(1 * H) }),
        ],
        ['await', review({ id: 'await', leadId: 'L6' })],
      ]),
    });
    // today-completed task (1) + answered thread (1) + sent review (1) + skipped review (1);
    // the yesterday-completed task and the still-awaiting review do not count.
    expect(countDoneToday(data, NOW)).toBe(4);
  });
});

describe('nextTaskDueFor — recompute after completion', () => {
  test('returns the lead’s next due task, excluding the completed one', () => {
    const data = store({
      tasks: new Map([
        ['a', task({ id: 'a', leadId: 'L1', dueAt: ago(3 * D) })],
        ['b', task({ id: 'b', leadId: 'L1', dueAt: ago(1 * D) })],
        ['other', task({ id: 'other', leadId: 'L2', dueAt: ago(1 * D) })],
      ]),
    });
    expect(nextTaskDueFor('L1', data, 'a', NOW)).toBe(ago(1 * D));
    expect(nextTaskDueFor('L1', data, 'b', NOW)).toBe(ago(3 * D));
  });

  test('returns null when the lead has no other open task', () => {
    const data = store({
      tasks: new Map([['a', task({ id: 'a', leadId: 'L1' })]]),
    });
    expect(nextTaskDueFor('L1', data, 'a', NOW)).toBeNull();
  });
});
