import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { taskSchema, type ActivityType } from '@switchboard/shared';

import { activities, leads, tasks, users, type ActivityRow } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { registerTasksRoutes } from './tasks.ts';

/**
 * Tasks CRUD routes (CONTRACTS §C7 `tasks`, §C4 events, §C8 errors). Drives the
 * plugin through `fastify.inject` against PGlite. Asserts the plain-array reads,
 * the `task_created` / `task_completed` events, the C8 failure paths, AND the
 * denormalized `leads.next_task_due_at` staying consistent across create /
 * complete / delete (the writer maintains it on events; the service maintains it
 * on the non-event delete).
 */

const USER = '00000000-0000-4000-8000-0000000000b1';
const USER2 = '00000000-0000-4000-8000-0000000000b2';
const LEAD = '11111111-0000-4000-8000-0000000000c1';
const MISSING = '99999999-0000-4000-8000-000000000999';

const DUE_EARLY = '2026-08-01T09:00:00.000Z';
const DUE_LATE = '2026-08-05T09:00:00.000Z';
const COMPLETED_AT = '2026-07-17T15:00:00.000Z';

let ctx: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.client.exec(`SET TIME ZONE 'UTC'`);

  await ctx.db.insert(users).values([
    { id: USER, email: 'rep@example.com', name: 'Rep', role: 'rep', idpSubject: 'idp|b1' },
    { id: USER2, email: 'rep2@example.com', name: 'Rep2', role: 'rep', idpSubject: 'idp|b2' },
  ]);
  await ctx.db.insert(leads).values([{ id: LEAD, name: 'Acme', ownerId: USER }]);

  app = Fastify({ logger: false });
  registerTasksRoutes(app, { db: ctx.db });
  await app.ready();
}, 120_000);

beforeEach(async () => {
  await ctx.db.delete(activities);
  await ctx.db.delete(tasks);
  await ctx.db.update(leads).set({ nextTaskDueAt: null }).where(eq(leads.id, LEAD));
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

async function eventsOfType(leadId: string, type: ActivityType): Promise<ActivityRow[]> {
  return ctx.db
    .select()
    .from(activities)
    .where(and(eq(activities.leadId, leadId), eq(activities.type, type)));
}

/** The lead's denormalized next-task-due, normalized to ISO (or null). */
async function leadNextDue(leadId: string): Promise<string | null> {
  const rows = await ctx.db
    .select({ v: leads.nextTaskDueAt })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  const v = rows[0]?.v ?? null;
  return v === null ? null : new Date(v).toISOString();
}

async function createTask(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/tasks', payload: body });
  expect(res.statusCode).toBe(201);
  return res.json<Record<string, unknown>>();
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('POST /api/v1/tasks', () => {
  test('creates a task, 201 + ISO DTO, emits task_created, sets next_task_due_at', async () => {
    const task = await createTask({
      leadId: LEAD,
      title: 'Follow up',
      assigneeId: USER,
      dueAt: DUE_LATE,
      createdBy: USER,
      actorId: USER,
    });
    expect(task.title).toBe('Follow up');
    expect(task.assigneeId).toBe(USER);
    expect(task.completedAt).toBeNull();
    expect(task.dueAt).toBe(DUE_LATE);
    expect(task.createdAt).toMatch(ISO_RE);

    const created = await eventsOfType(LEAD, 'task_created');
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({ taskId: task.id, title: 'Follow up' });

    expect(await leadNextDue(LEAD)).toBe(DUE_LATE);
  });

  test('unknown leadId → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { leadId: MISSING, title: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  test('unknown assigneeId → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { leadId: LEAD, title: 'x', assigneeId: MISSING },
    });
    expect(res.statusCode).toBe(400);
  });

  test('missing title → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { leadId: LEAD },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/tasks', () => {
  test('?leadId= returns a plain array', async () => {
    await createTask({ leadId: LEAD, title: 'A' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/tasks?leadId=${LEAD}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<unknown>();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });

  test('?assigneeId= filters by assignee', async () => {
    await createTask({ leadId: LEAD, title: 'mine', assigneeId: USER });
    await createTask({ leadId: LEAD, title: 'theirs', assigneeId: USER2 });
    const res = await app.inject({ method: 'GET', url: `/api/v1/tasks?assigneeId=${USER}` });
    const body = res.json<Array<{ title: string }>>();
    expect(body).toHaveLength(1);
    expect(body[0]?.title).toBe('mine');
  });

  test('no filter → 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/tasks/:id', () => {
  test('returns the task; unknown → 404; non-uuid → 400', async () => {
    const task = await createTask({ leadId: LEAD, title: 'T' });
    const ok = await app.inject({ method: 'GET', url: `/api/v1/tasks/${String(task.id)}` });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/tasks/${MISSING}` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: '/api/v1/tasks/abc' })).statusCode).toBe(400);
  });
});

describe('PATCH /api/v1/tasks/:id — complete via completedAt', () => {
  test('open → completed emits task_completed and recomputes next_task_due_at', async () => {
    await createTask({ leadId: LEAD, title: 'late', dueAt: DUE_LATE });
    const early = await createTask({ leadId: LEAD, title: 'early', dueAt: DUE_EARLY });
    expect(await leadNextDue(LEAD)).toBe(DUE_EARLY);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${String(early.id)}`,
      payload: { completedAt: COMPLETED_AT, actorId: USER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ completedAt: string }>().completedAt).toBe(COMPLETED_AT);

    const completed = await eventsOfType(LEAD, 'task_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ taskId: early.id, completedAt: COMPLETED_AT });

    // The completed (earlier) task no longer counts; next-due falls back to the late one.
    expect(await leadNextDue(LEAD)).toBe(DUE_LATE);
  });

  test('completing an already-completed task emits no second event (idempotent)', async () => {
    const task = await createTask({ leadId: LEAD, title: 'T', dueAt: DUE_EARLY });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${String(task.id)}`,
      payload: { completedAt: COMPLETED_AT },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${String(task.id)}`,
      payload: { completedAt: '2026-07-18T10:00:00.000Z' },
    });
    expect(await eventsOfType(LEAD, 'task_completed')).toHaveLength(1);
  });

  test('due-date change emits no task_completed but keeps next_task_due_at consistent', async () => {
    const task = await createTask({ leadId: LEAD, title: 'T', dueAt: DUE_LATE });
    expect(await leadNextDue(LEAD)).toBe(DUE_LATE);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${String(task.id)}`,
      payload: { dueAt: DUE_EARLY },
    });
    expect(res.statusCode).toBe(200);
    expect(await eventsOfType(LEAD, 'task_completed')).toHaveLength(0);
    expect(await leadNextDue(LEAD)).toBe(DUE_EARLY);
  });

  test('empty patch → 400; unknown assignee → 400; unknown id → 404', async () => {
    const task = await createTask({ leadId: LEAD, title: 'T' });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/tasks/${String(task.id)}`,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/tasks/${String(task.id)}`,
          payload: { assigneeId: MISSING },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/tasks/${MISSING}`,
          payload: { completedAt: COMPLETED_AT },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('DELETE /api/v1/tasks/:id', () => {
  test('deletes, 204, recomputes next_task_due_at, and GET → 404', async () => {
    const task = await createTask({ leadId: LEAD, title: 'T', dueAt: DUE_EARLY });
    expect(await leadNextDue(LEAD)).toBe(DUE_EARLY);
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/tasks/${String(task.id)}` });
    expect(del.statusCode).toBe(204);
    expect(await leadNextDue(LEAD)).toBeNull();
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/tasks/${String(task.id)}` })).statusCode,
    ).toBe(404);
  });

  test('unknown id → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/tasks/${MISSING}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('DTO conformance (drop-in for the web inbox `completeTask` → §C1/§C7 Task)', () => {
  test('POST result, the PATCH-complete result, and list items all parse as taskSchema', async () => {
    const created = await createTask({
      leadId: LEAD,
      title: 'T',
      dueAt: DUE_LATE,
      assigneeId: USER,
    });
    expect(() => taskSchema.strict().parse(created)).not.toThrow();

    // The web's completeTask sends { completedAt } and binds the returned Task.
    const completed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${String(created.id)}`,
      payload: { completedAt: COMPLETED_AT },
    });
    expect(() => taskSchema.strict().parse(completed.json())).not.toThrow();
    expect(completed.json<{ completedAt: string }>().completedAt).toBe(COMPLETED_AT);

    const list = await app.inject({ method: 'GET', url: `/api/v1/tasks?leadId=${LEAD}` });
    for (const item of list.json<unknown[]>()) {
      expect(() => taskSchema.strict().parse(item)).not.toThrow();
    }
  });
});
