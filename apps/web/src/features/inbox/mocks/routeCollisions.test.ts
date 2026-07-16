import { beforeEach, describe, expect, test } from 'vitest';
import type { Contact, Lead } from '@switchboard/shared';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { getInboxStore, resetInboxStore } from '../model/store.ts';
import { buildQueue } from '../model/queue.ts';
import { INBOX_NOW_MS } from '../model/time.ts';
import { completeTask, sendReply } from '../api/inbox.ts';
import type { ReplyItem, TaskItem } from '../model/types.ts';
import { commsStore, isEmailSuppressed, resetCommsStore } from '../../comms/data/store.ts';
import { sendEmail } from '../../comms/api/comms.ts';

/*
 * Regression suite for the inbox ⇄ comms MSW route collision on POST /emails/send
 * (+ /sms/send) and the inbox ⇄ core collision on PATCH /tasks/:id.
 *
 * Like features/comms/mocks/routeCollisions.test.tsx, these run against the SHARED
 * `server` (src/mocks/server.ts) in its PRODUCTION spread order —
 *   handlers → inbox → pipeline → admin → reports → comms → view-builder → leadDetail
 * — the same first-match-wins order the browser worker uses (src/mocks/browser.ts).
 * They deliberately DO NOT `server.use(...inboxHandlers)` / `...commsHandlers`: that
 * boosts a feature's handlers to the top and hides the collision that only bites in
 * the real browser (the boss clicking "Send"). The whole point is that the inbox's
 * shared-route handlers are cooperative — they own a request only when it targets an
 * inbox-store item and otherwise return undefined to fall through.
 */

/** The first open EMAIL reply in the seeded queue (routes to POST /emails/send). */
function firstEmailReply(): ReplyItem {
  const item = buildQueue(getInboxStore()).find(
    (i): i is ReplyItem => i.kind === 'reply' && i.channel === 'email',
  );
  if (!item) throw new Error('seed has no open email reply');
  return item;
}

/** The first open task in the seeded queue (routes to PATCH /tasks/:id). */
function firstOpenTask(): TaskItem {
  const item = buildQueue(getInboxStore()).find((i): i is TaskItem => i.kind === 'task');
  if (!item) throw new Error('seed has no open task');
  return item;
}

/** A non-DNC lead + first non-DNC, non-suppressed contact email (a composer target). */
function pickComposableRecipient(): { lead: Lead; contact: Contact; email: string } {
  for (const lead of db.leads) {
    if (lead.dnc) continue;
    for (const contact of db.contacts) {
      if (contact.leadId !== lead.id || contact.deletedAt !== null || contact.dnc) continue;
      const email = contact.emails[0]?.email;
      if (email && !isEmailSuppressed(email)) return { lead, contact, email };
    }
  }
  throw new Error('fixture has no composable (non-DNC, non-suppressed) recipient');
}

beforeEach(() => {
  resetInboxStore();
  resetCommsStore();
  // NOTE: no server.use(...) — exercise the real default handler order.
});

describe('inbox ⇄ comms/core MSW route collisions (production handler order)', () => {
  // ── The inbox reply owns POST /emails/send when the threadId is one it holds ──
  test('an inbox reply POST /emails/send {threadId} mutates the inbox store', async () => {
    const reply = firstEmailReply();
    expect(getInboxStore().threads.get(reply.threadId)?.answered).toBe(false);

    const sent = await sendReply({
      threadId: reply.threadId,
      channel: 'email',
      to: reply.toAddress,
      subject: reply.subject,
      body: 'Thanks — answers below.',
      leadId: reply.leadId,
    });

    // Answered by the inbox handler (not the comms composer): out-message on the thread.
    expect(sent.direction).toBe('out');
    expect(sent.threadId).toBe(reply.threadId);
    // The store really mutated: thread marked answered, and the row leaves the queue.
    const thread = getInboxStore().threads.get(reply.threadId);
    expect(thread?.answered).toBe(true);
    expect(thread?.messages.at(-1)?.direction).toBe('out');
    expect(buildQueue(getInboxStore()).some((i) => i.id === reply.id)).toBe(false);
  });

  // ── A composer send (no inbox threadId) falls through inbox → comms answers ───
  test('a comms composer POST /emails/send (no inbox threadId) still returns {message}', async () => {
    const { lead, contact, email } = pickComposableRecipient();
    const before = commsStore.outbox.length;

    const { message } = await sendEmail({
      leadId: lead.id,
      contactId: contact.id,
      to: [email],
      subject: 'Quick note',
      body: 'Hello from the composer.',
    });

    // Answered by comms (the {message} envelope + a grown outbox), proving inbox
    // yielded for a send with no threadId it owns.
    expect(message.leadId).toBe(lead.id);
    expect(message.to).toContain(email);
    expect(commsStore.outbox.length).toBe(before + 1);
    expect(commsStore.outbox[0]?.id).toBe(message.id);
  });

  // ── A non-inbox task PATCH falls through (inbox does not 404-shadow it) ────────
  test('PATCH /tasks/:id for a non-inbox task falls through (matched but not mock-answered)', async () => {
    const orphanId = crypto.randomUUID();
    expect(getInboxStore().tasks.has(orphanId)).toBe(false);
    const path = `/api/v1/tasks/${orphanId}`;

    // The inbox handler's predicate matches PATCH /tasks/:id (so `request:match`
    // fires), but for a task it does not own it returns undefined — it YIELDS. No
    // other mock owns the route, so the mock layer produces NO response for it
    // (`response:mocked` never fires; MSW passes it through to the real backend).
    // Had inbox 404-shadowed (the old bug), `response:mocked` WOULD fire here. This
    // signal is network-independent — it is decided before the passthrough leg.
    const matched: string[] = [];
    const mocked: string[] = [];
    const onMatch = ({ request }: { request: Request }): void => {
      matched.push(new URL(request.url).pathname);
    };
    const onMocked = ({ request }: { request: Request }): void => {
      mocked.push(new URL(request.url).pathname);
    };
    server.events.on('request:match', onMatch);
    server.events.on('response:mocked', onMocked);
    try {
      await fetch(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completedAt: new Date(INBOX_NOW_MS).toISOString() }),
      }).catch(() => undefined);
    } finally {
      server.events.removeListener('request:match', onMatch);
      server.events.removeListener('response:mocked', onMocked);
    }
    expect(matched).toContain(path); // the inbox predicate matched the route…
    expect(mocked).not.toContain(path); // …but no mock answered it — inbox yielded.
  });

  // ── The owned branch still works under the real order (guards the pass-through) ─
  test('an inbox-owned task PATCH still completes in production order', async () => {
    const task = firstOpenTask();
    expect(getInboxStore().tasks.get(task.taskId)?.completedAt).toBeNull();

    const updated = await completeTask(task.taskId);

    expect(updated.completedAt).not.toBeNull();
    expect(getInboxStore().tasks.get(task.taskId)?.completedAt).not.toBeNull();
    expect(buildQueue(getInboxStore()).some((i) => i.id === task.id)).toBe(false);
  });
});
