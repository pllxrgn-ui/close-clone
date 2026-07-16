import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import { LeadNotFoundError } from '../services/activity/index.ts';
import {
  InvalidTaskReferenceError,
  TaskLeadNotFoundError,
  TaskNotFoundError,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  patchTask,
  type CreateTaskInput,
  type ListTasksFilter,
  type PatchTaskInput,
} from '../services/tasks/index.ts';
import { sendError } from './http.ts';

/**
 * Tasks CRUD routes (CONTRACTS §C7 `tasks`). A Fastify plugin factory. The web
 * drives `PATCH /tasks/:id` (inbox "complete", body `{ completedAt }`) today; the
 * full CRUD is provided per §C7 as the real-API drop-in.
 *
 *   GET    /api/v1/tasks?leadId=|assigneeId=  — plain array (a filter is required).
 *   GET    /api/v1/tasks/:id
 *   POST   /api/v1/tasks                      — create (→ `task_created`).
 *   PATCH  /api/v1/tasks/:id                  — complete via `completedAt`
 *                                               (null → set ⇒ `task_completed`);
 *                                               also title/dueAt/assignee.
 *   DELETE /api/v1/tasks/:id                  — hard delete (recomputes next-due).
 */

export interface TasksRouteDeps {
  db: Db;
}

const listQuerySchema = z
  .object({
    leadId: z.string().uuid().optional(),
    assigneeId: z.string().uuid().optional(),
  })
  .refine((v) => v.leadId !== undefined || v.assigneeId !== undefined, {
    message: 'one of leadId or assigneeId is required',
  });

const idParamSchema = z.object({ id: z.string().uuid() });

const createBodySchema = z.object({
  leadId: z.string().uuid(),
  title: z.string().min(1).max(500),
  assigneeId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  createdBy: z.string().uuid().nullable().optional(),
  actorId: z.string().uuid().optional(),
});

const patchBodySchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    completedAt: z.string().datetime({ offset: true }).nullable().optional(),
    actorId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.dueAt !== undefined ||
      v.assigneeId !== undefined ||
      v.completedAt !== undefined,
    { message: 'provide at least one field to update' },
  );

/** Map a tasks-service error to its C8 envelope; null if not a known error. */
function mapTaskError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof TaskNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof TaskLeadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof LeadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof InvalidTaskReferenceError) {
    return sendError(reply, 'VALIDATION_FAILED', err.message);
  }
  return null;
}

export function registerTasksRoutes(app: FastifyInstance, deps: TasksRouteDeps): void {
  const { db } = deps;

  // GET /api/v1/tasks?leadId=|assigneeId=
  app.get('/api/v1/tasks', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid tasks query', parsed.error.flatten());
    }
    const filter: ListTasksFilter = {
      ...(parsed.data.leadId !== undefined ? { leadId: parsed.data.leadId } : {}),
      ...(parsed.data.assigneeId !== undefined ? { assigneeId: parsed.data.assigneeId } : {}),
    };
    return reply.send(await listTasks(db, filter));
  });

  // GET /api/v1/tasks/:id
  app.get('/api/v1/tasks/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid task id');
    try {
      return reply.send(await getTask(db, params.data.id));
    } catch (err) {
      const mapped = mapTaskError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // POST /api/v1/tasks
  app.post('/api/v1/tasks', async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid task', parsed.error.flatten());
    }
    const d = parsed.data;
    const input: CreateTaskInput = {
      leadId: d.leadId,
      title: d.title,
      ...(d.assigneeId !== undefined ? { assigneeId: d.assigneeId } : {}),
      ...(d.dueAt !== undefined ? { dueAt: d.dueAt } : {}),
      ...(d.createdBy !== undefined ? { createdBy: d.createdBy } : {}),
      ...(d.actorId !== undefined ? { actorId: d.actorId } : {}),
    };
    try {
      const created = await createTask(db, input);
      return reply.status(201).send(created);
    } catch (err) {
      const mapped = mapTaskError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // PATCH /api/v1/tasks/:id
  app.patch('/api/v1/tasks/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid task id');
    const parsed = patchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid patch', parsed.error.flatten());
    }
    const d = parsed.data;
    const input: PatchTaskInput = {
      ...(d.title !== undefined ? { title: d.title } : {}),
      ...(d.dueAt !== undefined ? { dueAt: d.dueAt } : {}),
      ...(d.assigneeId !== undefined ? { assigneeId: d.assigneeId } : {}),
      ...(d.completedAt !== undefined ? { completedAt: d.completedAt } : {}),
      ...(d.actorId !== undefined ? { actorId: d.actorId } : {}),
    };
    try {
      const updated = await patchTask(db, params.data.id, input);
      return reply.send(updated);
    } catch (err) {
      const mapped = mapTaskError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // DELETE /api/v1/tasks/:id
  app.delete('/api/v1/tasks/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid task id');
    try {
      await deleteTask(db, params.data.id);
      return reply.status(204).send();
    } catch (err) {
      const mapped = mapTaskError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
