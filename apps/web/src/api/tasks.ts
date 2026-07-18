import type { Task } from '@switchboard/shared';
import { apiRequest } from './client.ts';

/*
 * Tasks client (CONTRACTS §C7 tasks CRUD). Create is used by the lead-page
 * "Task" launcher; completion lives with the inbox feature (PATCH /tasks/:id).
 * Same route + DTO in mock and real mode — credentials change nothing here.
 */

export interface CreateTaskInput {
  leadId: string;
  title: string;
  /** Defaults server-side to unassigned; the launcher sends the current user. */
  assigneeId?: string;
  /** ISO datetime (offset allowed) or null for no due date. */
  dueAt?: string | null;
}

/** `POST /api/v1/tasks` — creates the task and lands a task_created activity. */
export function createTask(input: CreateTaskInput): Promise<Task> {
  return apiRequest<Task>('/tasks', { method: 'POST', body: input });
}
