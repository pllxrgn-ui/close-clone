import { beforeEach, describe, expect, test } from 'vitest';
import { server } from '../../../mocks/server.ts';
import { ApiError, apiRequest } from '../../../api/index.ts';
import { inboxHandlers } from './inboxHandlers.ts';
import {
  getInboxQueue,
  getInboxStats,
  approveReview,
  completeTask,
  sendReply,
  skipReview,
  snoozeItem,
} from '../api/inbox.ts';
import { loadInboxStore, resetInboxStore } from '../model/store.ts';
import type { InboxStoreData, StoredReview, StoredThread } from '../model/store.ts';
import { INBOX_NOW_MS } from '../model/time.ts';
import type { InboxItem, ReplyItem, ReviewItem, TaskItem } from '../model/types.ts';

const ago = (ms: number): string => new Date(INBOX_NOW_MS - ms).toISOString();
const H = 3_600_000;

function firstOfKind<K extends InboxItem['kind']>(
  items: InboxItem[],
  kind: K,
): Extract<InboxItem, { kind: K }> {
  const found = items.find((i) => i.kind === kind);
  if (!found) throw new Error(`no ${kind} item in queue`);
  return found as Extract<InboxItem, { kind: K }>;
}

function dncStore(over: Partial<InboxStoreData>): InboxStoreData {
  return {
    threads: over.threads ?? new Map(),
    tasks: over.tasks ?? new Map(),
    reviews: over.reviews ?? new Map(),
    leadNames: new Map([['DNC', 'Sable Freight']]),
    leadDnc: new Map([['DNC', true]]),
  };
}
function dncThread(): StoredThread {
  return {
    id: 'th-dnc',
    leadId: 'DNC',
    contactId: null,
    contactName: 'Pat Lee',
    channel: 'email',
    toAddress: 'pat@sable.test',
    subject: 'Re: quote',
    snippet: 'hi',
    lastInboundAt: ago(2 * H),
    lastContactedAt: ago(48 * H),
    answered: false,
    answeredAt: null,
    snoozedUntil: null,
    messages: [],
  };
}
function dncReview(): StoredReview {
  return {
    id: 'rv-dnc',
    enrollmentId: 'en',
    stepId: 'sp',
    sequenceId: 'sq',
    leadId: 'DNC',
    contactId: null,
    contactName: 'Pat Lee',
    sequenceName: 'Win-back',
    stepIndex: 2,
    stepCount: 3,
    channel: 'email',
    subject: 'Idea',
    preview: 'Hi',
    dueAt: ago(3 * H),
    state: 'AWAITING_REVIEW',
    disposition: null,
    dispositionedAt: null,
    snoozedUntil: null,
  };
}

beforeEach(() => {
  resetInboxStore();
  server.use(...inboxHandlers);
});

describe('GET /inbox + /inbox/stats', () => {
  test('returns the C7 envelope and coherent stats', async () => {
    const { items } = await getInboxQueue();
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    const sample = items[0];
    expect(sample).toHaveProperty('kind');
    expect(sample).toHaveProperty('leadName');
    expect(sample).toHaveProperty('lamp');

    const stats = await getInboxStats();
    expect(stats.needsYouNow).toBe(items.length);
    expect(stats.overdue).toBe(items.filter((i) => i.kind === 'task').length);
    expect(stats.doneToday).toBeGreaterThan(0);
  });
});

describe('POST /emails/send (reply)', () => {
  test('sends, removes the row, and bumps Done today', async () => {
    const before = await getInboxQueue();
    const reply: ReplyItem = firstOfKind(before.items, 'reply');
    const statsBefore = await getInboxStats();

    const sent = await sendReply({
      threadId: reply.threadId,
      channel: reply.channel,
      to: reply.toAddress,
      subject: reply.subject,
      body: 'Thanks — answers below.',
      leadId: reply.leadId,
    });
    expect(sent.direction).toBe('out');
    expect(sent.threadId).toBe(reply.threadId);

    const after = await getInboxQueue();
    expect(after.items.some((i) => i.id === reply.id)).toBe(false);
    const statsAfter = await getInboxStats();
    expect(statsAfter.needsYouNow).toBe(statsBefore.needsYouNow - 1);
    expect(statsAfter.doneToday).toBe(statsBefore.doneToday + 1);
  });

  test('missing body → 400 VALIDATION_FAILED', async () => {
    await expect(
      apiRequest('/emails/send', { method: 'POST', body: { threadId: 'x', to: 'a@b.test' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  });

  test('reply to a DNC lead → 422 SUPPRESSED (rail holds via the API)', async () => {
    loadInboxStore(dncStore({ threads: new Map([['th-dnc', dncThread()]]) }));
    server.use(...inboxHandlers);
    let error: unknown;
    try {
      await sendReply({
        threadId: 'th-dnc',
        channel: 'email',
        to: 'pat@sable.test',
        subject: 'Re: quote',
        body: 'hello',
        leadId: 'DNC',
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'SUPPRESSED', status: 422 });
  });
});

describe('PATCH /tasks/:id (complete)', () => {
  test('completes the task, removes the row, bumps Done today', async () => {
    const before = await getInboxQueue();
    const task: TaskItem = firstOfKind(before.items, 'task');
    const statsBefore = await getInboxStats();

    const updated = await completeTask(task.taskId);
    expect(updated.completedAt).not.toBeNull();

    const after = await getInboxQueue();
    expect(after.items.some((i) => i.id === task.id)).toBe(false);
    const statsAfter = await getInboxStats();
    expect(statsAfter.doneToday).toBe(statsBefore.doneToday + 1);
  });

  test('unknown task id → 404 NOT_FOUND', async () => {
    await expect(completeTask('does-not-exist')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('review approve / skip', () => {
  test('approve marks the step SENT and removes it', async () => {
    const before = await getInboxQueue();
    const review: ReviewItem = firstOfKind(before.items, 'review');
    const statsBefore = await getInboxStats();

    const result = await approveReview(review.intentId);
    expect(result.state).toBe('SENT');

    const after = await getInboxQueue();
    expect(after.items.some((i) => i.id === review.id)).toBe(false);
    expect((await getInboxStats()).doneToday).toBe(statsBefore.doneToday + 1);
  });

  test('skip marks the step SKIPPED and removes it', async () => {
    const review: ReviewItem = firstOfKind((await getInboxQueue()).items, 'review');
    const result = await skipReview(review.intentId);
    expect(result.state).toBe('SKIPPED');
    expect((await getInboxQueue()).items.some((i) => i.id === review.id)).toBe(false);
  });

  test('approve on a DNC lead → 422 SUPPRESSED', async () => {
    loadInboxStore(dncStore({ reviews: new Map([['rv-dnc', dncReview()]]) }));
    server.use(...inboxHandlers);
    await expect(approveReview('rv-dnc')).rejects.toMatchObject({
      code: 'SUPPRESSED',
      status: 422,
    });
  });

  test('unknown review id → 404', async () => {
    await expect(approveReview('nope')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

describe('POST /inbox/snooze', () => {
  test('snoozing removes the row but does not count as done', async () => {
    const before = await getInboxQueue();
    const item = before.items[0];
    if (!item) throw new Error('queue was empty');
    const statsBefore = await getInboxStats();

    const result = await snoozeItem(item.id);
    expect(result.snoozedUntil).toBeTruthy();

    const after = await getInboxQueue();
    expect(after.items.some((i) => i.id === item.id)).toBe(false);
    const statsAfter = await getInboxStats();
    expect(statsAfter.needsYouNow).toBe(statsBefore.needsYouNow - 1);
    expect(statsAfter.doneToday).toBe(statsBefore.doneToday);
  });

  test('missing itemId → 400', async () => {
    await expect(apiRequest('/inbox/snooze', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });
  });

  test('unknown item id → 404', async () => {
    await expect(snoozeItem('task:ghost')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});
