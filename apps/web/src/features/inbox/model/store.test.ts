import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../../../mocks/fixtures.ts';
import {
  applyApproveReview,
  applyCompleteTask,
  applySendReply,
  applySkipReview,
  applySnooze,
  getInboxStore,
  InboxNotFoundError,
  InboxSuppressedError,
  loadInboxStore,
  resetInboxStore,
} from './store.ts';
import type { InboxStoreData, StoredReview, StoredTask, StoredThread } from './store.ts';
import { buildQueue, countDoneToday, groupSections } from './queue.ts';
import { INBOX_NOW_MS, startOfTomorrow } from './time.ts';

const NOW = INBOX_NOW_MS;
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function tinyStore(over: Partial<InboxStoreData> = {}): InboxStoreData {
  return {
    threads: over.threads ?? new Map(),
    tasks: over.tasks ?? new Map(),
    reviews: over.reviews ?? new Map(),
    leadNames: over.leadNames ?? new Map([['L1', 'North Labs']]),
    leadDnc: over.leadDnc ?? new Map([['L1', false]]),
  };
}
function thread(over: Partial<StoredThread> & { id: string }): StoredThread {
  return {
    leadId: 'L1',
    contactId: null,
    contactName: 'Sam Patel',
    channel: 'email',
    toAddress: 'sam@acme.test',
    subject: 'Re: pilot',
    snippet: 'Two questions…',
    lastInboundAt: ago(2 * H),
    lastContactedAt: ago(3 * D),
    answered: false,
    answeredAt: null,
    snoozedUntil: null,
    messages: [
      { id: 'm1', direction: 'in', subject: 'Re: pilot', body: 'Two questions…', at: ago(2 * H) },
    ],
    ...over,
  };
}
function task(over: Partial<StoredTask> & { id: string }): StoredTask {
  return {
    leadId: 'L1',
    title: 'Follow up',
    dueAt: ago(2 * D),
    completedAt: null,
    snoozedUntil: null,
    ...over,
  };
}
function review(over: Partial<StoredReview> & { id: string }): StoredReview {
  return {
    leadId: 'L1',
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

beforeEach(() => resetInboxStore());

describe('applyCompleteTask', () => {
  test('checks off, removes from queue, increments done today', () => {
    loadInboxStore(tinyStore({ tasks: new Map([['t', task({ id: 't' })]]) }));
    expect(buildQueue(getInboxStore(), NOW)).toHaveLength(1);
    const updated = applyCompleteTask('t');
    expect(updated.completedAt).not.toBeNull();
    expect(buildQueue(getInboxStore(), NOW)).toHaveLength(0);
    expect(countDoneToday(getInboxStore(), NOW)).toBe(1);
  });

  test('unknown task id throws NotFound', () => {
    loadInboxStore(tinyStore());
    expect(() => applyCompleteTask('nope')).toThrow(InboxNotFoundError);
  });
});

describe('applySendReply', () => {
  test('appends outbound, marks answered, removes reply, counts as done', () => {
    loadInboxStore(tinyStore({ threads: new Map([['r', thread({ id: 'r' })]]) }));
    const updated = applySendReply('r', { subject: 'Re: pilot', body: 'Answers below.' });
    expect(updated.answered).toBe(true);
    expect(updated.answeredAt).not.toBeNull();
    expect(updated.lastContactedAt).not.toBeNull();
    const outbound = updated.messages.filter((m) => m.direction === 'out');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.body).toBe('Answers below.');
    expect(buildQueue(getInboxStore(), NOW)).toHaveLength(0);
    expect(countDoneToday(getInboxStore(), NOW)).toBe(1);
  });

  test('SMS reply carries no subject on the outbound message', () => {
    loadInboxStore(
      tinyStore({ threads: new Map([['r', thread({ id: 'r', channel: 'sms', subject: null })]]) }),
    );
    const updated = applySendReply('r', { subject: 'ignored', body: 'On my way.' });
    expect(updated.messages.at(-1)?.subject).toBeNull();
  });

  test('DNC lead blocks the send (SUPPRESSED) and leaves the thread unanswered', () => {
    loadInboxStore(
      tinyStore({
        threads: new Map([['r', thread({ id: 'r' })]]),
        leadDnc: new Map([['L1', true]]),
      }),
    );
    expect(() => applySendReply('r', { subject: null, body: 'hi' })).toThrow(InboxSuppressedError);
    expect(getInboxStore().threads.get('r')?.answered).toBe(false);
  });

  test('unknown thread id throws NotFound', () => {
    loadInboxStore(tinyStore());
    expect(() => applySendReply('nope', { subject: null, body: 'x' })).toThrow(InboxNotFoundError);
  });
});

describe('applyApproveReview / applySkipReview', () => {
  test('approve sends the step, removes it, counts as done', () => {
    loadInboxStore(tinyStore({ reviews: new Map([['v', review({ id: 'v' })]]) }));
    const updated = applyApproveReview('v');
    expect(updated.state).toBe('SENT');
    expect(updated.disposition).toBe('approved');
    expect(buildQueue(getInboxStore(), NOW)).toHaveLength(0);
    expect(countDoneToday(getInboxStore(), NOW)).toBe(1);
  });

  test('approve on a DNC lead is blocked (SUPPRESSED)', () => {
    loadInboxStore(
      tinyStore({
        reviews: new Map([['v', review({ id: 'v' })]]),
        leadDnc: new Map([['L1', true]]),
      }),
    );
    expect(() => applyApproveReview('v')).toThrow(InboxSuppressedError);
    expect(getInboxStore().reviews.get('v')?.state).toBe('AWAITING_REVIEW');
  });

  test('skip dispositions the step, removes it, counts as done — even on a DNC lead', () => {
    loadInboxStore(
      tinyStore({
        reviews: new Map([['v', review({ id: 'v' })]]),
        leadDnc: new Map([['L1', true]]),
      }),
    );
    const updated = applySkipReview('v');
    expect(updated.state).toBe('SKIPPED');
    expect(buildQueue(getInboxStore(), NOW)).toHaveLength(0);
    expect(countDoneToday(getInboxStore(), NOW)).toBe(1);
  });

  test('unknown review id throws NotFound', () => {
    loadInboxStore(tinyStore());
    expect(() => applyApproveReview('nope')).toThrow(InboxNotFoundError);
    expect(() => applySkipReview('nope')).toThrow(InboxNotFoundError);
  });
});

describe('applySnooze', () => {
  test('snoozing removes the row until tomorrow without counting as done', () => {
    loadInboxStore(
      tinyStore({
        threads: new Map([['r', thread({ id: 'r' })]]),
        tasks: new Map([['t', task({ id: 't' })]]),
        reviews: new Map([['v', review({ id: 'v' })]]),
      }),
    );
    const until = new Date(startOfTomorrow(NOW)).toISOString();
    applySnooze('reply:r', until);
    applySnooze('task:t', until);
    applySnooze('review:v', until);
    expect(buildQueue(getInboxStore(), NOW)).toHaveLength(0);
    expect(countDoneToday(getInboxStore(), NOW)).toBe(0);
  });

  test('unknown item id throws NotFound', () => {
    loadInboxStore(tinyStore());
    expect(() => applySnooze('task:nope', 'x')).toThrow(InboxNotFoundError);
    expect(() => applySnooze('bogus:1', 'x')).toThrow(InboxNotFoundError);
  });
});

describe('resetInboxStore', () => {
  test('restores the seeded queue after mutations', () => {
    const before = buildQueue(getInboxStore(), NOW).length;
    const first = buildQueue(getInboxStore(), NOW)[0];
    if (first?.kind === 'task') applyCompleteTask(first.taskId);
    resetInboxStore();
    expect(buildQueue(getInboxStore(), NOW).length).toBe(before);
  });
});

describe('deterministic seed — coherence with the fixture board', () => {
  test('queue is demo-sized and section-ordered', () => {
    const data = getInboxStore();
    const q = buildQueue(data, NOW);
    const tasks = q.filter((i) => i.kind === 'task');
    const replies = q.filter((i) => i.kind === 'reply');
    const reviews = q.filter((i) => i.kind === 'review');
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.length).toBeLessThanOrEqual(6);
    expect(reviews.length).toBeLessThanOrEqual(4);
    expect(tasks.length).toBeLessThanOrEqual(7); // 6 task-leads + 1 second task
    // section order holds in the flat list
    expect(groupSections(q).map((s) => s.id)).toEqual(['overdue', 'replies', 'reviews']);
  });

  test('starts with a non-zero Done today baseline', () => {
    expect(countDoneToday(getInboxStore(), NOW)).toBeGreaterThan(0);
  });

  test('names every fixture lead and never queues a reply/review for a DNC lead', () => {
    const data = getInboxStore();
    expect(data.leadNames.size).toBe(db.leads.length);
    for (const item of buildQueue(data, NOW)) {
      if (item.kind === 'reply' || item.kind === 'review') {
        expect(data.leadDnc.get(item.leadId)).not.toBe(true);
      }
    }
  });

  test('reply rows mirror the fixture lead’s real inbound timestamp', () => {
    const data = getInboxStore();
    const reply = buildQueue(data, NOW).find((i) => i.kind === 'reply');
    expect(reply).toBeDefined();
    if (reply?.kind === 'reply') {
      const lead = db.leads.find((l) => l.id === reply.leadId);
      expect(reply.receivedAt).toBe(lead?.lastInboundAt);
    }
  });
});
