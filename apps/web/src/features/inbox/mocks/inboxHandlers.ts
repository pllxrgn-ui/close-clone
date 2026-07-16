import { http, HttpResponse } from 'msw';
import type { Task } from '@switchboard/shared';
import {
  applyApproveReview,
  applyCompleteTask,
  applySendReply,
  applySkipReview,
  applySnooze,
  getInboxStore,
  InboxNotFoundError,
  InboxSuppressedError,
} from '../model/store.ts';
import type { StoredTask } from '../model/store.ts';
import { buildQueue, computeStats } from '../model/queue.ts';
import { nowIso, startOfTomorrow } from '../model/time.ts';

/*
 * MSW handlers for the Inbox, in the C7 envelope / C8 error shapes so the same UI
 * binds to the real API. They read and MUTATE the module-scoped store, so lists
 * and counters change for real and survive route changes within a session.
 *
 * Routes: GET /inbox and GET /inbox/stats (composed reads — no C7 CRUD equivalent),
 * POST /emails/send + /sms/send + PATCH /tasks/:id (faithful C7 routes), and the
 * inbox-scoped review/snooze actions. Register at merge by spreading
 * `inboxHandlers` into the worker/server arrays (see routeWiring); tests use
 * `server.use(...inboxHandlers)`.
 */

const api = (path: string): string => `*/api/v1${path}`;

function errorJson(status: number, code: string, message: string, details?: unknown) {
  const body =
    details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  return HttpResponse.json(body, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** Map the store's typed errors to C8 responses; unknown errors bubble as 500. */
function mapMutationError(err: unknown) {
  if (err instanceof InboxSuppressedError) {
    return errorJson(422, 'SUPPRESSED', err.message);
  }
  if (err instanceof InboxNotFoundError) {
    return errorJson(404, 'NOT_FOUND', err.message);
  }
  return errorJson(500, 'INTERNAL', 'Unexpected inbox error');
}

function toTaskDto(task: StoredTask): Task {
  return {
    id: task.id,
    leadId: task.leadId,
    assigneeId: null,
    title: task.title,
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    createdBy: null,
    createdAt: task.dueAt,
    updatedAt: nowIso(),
  };
}

export const inboxHandlers = [
  // ── Composed reads ──────────────────────────────────────────────────────────
  http.get(api('/inbox/stats'), () => HttpResponse.json(computeStats(getInboxStore()))),
  http.get(api('/inbox'), () => HttpResponse.json({ items: buildQueue(getInboxStore()) })),

  // ── Reply (C7 send routes) ──────────────────────────────────────────────────
  http.post(api('/emails/send'), async ({ request }) => {
    const body = await readJson(request);
    const threadId = body?.threadId;
    const to = body?.to;
    const text = body?.body;
    if (typeof threadId !== 'string' || typeof to !== 'string' || typeof text !== 'string') {
      return errorJson(400, 'VALIDATION_FAILED', 'threadId, to and body are required');
    }
    try {
      const subject = typeof body?.subject === 'string' ? body.subject : null;
      const thread = applySendReply(threadId, { subject, body: text });
      const message = thread.messages[thread.messages.length - 1];
      return HttpResponse.json(
        {
          id: message?.id ?? crypto.randomUUID(),
          threadId: thread.id,
          direction: 'out',
          to,
          subject: message?.subject ?? null,
          sentAt: message?.at ?? nowIso(),
        },
        { status: 201 },
      );
    } catch (err) {
      return mapMutationError(err);
    }
  }),

  http.post(api('/sms/send'), async ({ request }) => {
    const body = await readJson(request);
    const threadId = body?.threadId;
    const to = body?.to;
    const text = body?.body;
    if (typeof threadId !== 'string' || typeof to !== 'string' || typeof text !== 'string') {
      return errorJson(400, 'VALIDATION_FAILED', 'threadId, to and body are required');
    }
    try {
      const thread = applySendReply(threadId, { subject: null, body: text });
      const message = thread.messages[thread.messages.length - 1];
      return HttpResponse.json(
        {
          id: message?.id ?? crypto.randomUUID(),
          threadId: thread.id,
          direction: 'out',
          to,
          subject: null,
          sentAt: message?.at ?? nowIso(),
        },
        { status: 201 },
      );
    } catch (err) {
      return mapMutationError(err);
    }
  }),

  // ── Complete task (C7 tasks CRUD) ───────────────────────────────────────────
  http.patch(api('/tasks/:id'), async ({ params, request }) => {
    const id = String(params.id);
    // Only own inbox-known tasks; other task PATCHes fall through to their owner.
    if (!getInboxStore().tasks.has(id)) {
      return errorJson(404, 'NOT_FOUND', 'Task not found');
    }
    const body = await readJson(request);
    const completedAt = typeof body?.completedAt === 'string' ? body.completedAt : nowIso();
    try {
      return HttpResponse.json(toTaskDto(applyCompleteTask(id, completedAt)));
    } catch (err) {
      return mapMutationError(err);
    }
  }),

  // ── Sequence-step review (no C7 route — inbox-scoped) ───────────────────────
  http.post(api('/inbox/reviews/:id/approve'), ({ params }) => {
    try {
      const review = applyApproveReview(String(params.id));
      return HttpResponse.json({
        id: review.id,
        state: review.state,
        disposition: review.disposition,
      });
    } catch (err) {
      return mapMutationError(err);
    }
  }),
  http.post(api('/inbox/reviews/:id/skip'), ({ params }) => {
    try {
      const review = applySkipReview(String(params.id));
      return HttpResponse.json({
        id: review.id,
        state: review.state,
        disposition: review.disposition,
      });
    } catch (err) {
      return mapMutationError(err);
    }
  }),

  // ── Snooze (no C7 route — inbox-scoped) ─────────────────────────────────────
  http.post(api('/inbox/snooze'), async ({ request }) => {
    const body = await readJson(request);
    const itemId = body?.itemId;
    if (typeof itemId !== 'string') {
      return errorJson(400, 'VALIDATION_FAILED', 'itemId is required');
    }
    try {
      const until = new Date(startOfTomorrow()).toISOString();
      const result = applySnooze(itemId, until);
      return HttpResponse.json({ id: result.id, snoozedUntil: result.snoozedUntil });
    } catch (err) {
      return mapMutationError(err);
    }
  }),
];
