/**
 * Tasks CRUD service barrel (CONTRACTS §C7 `tasks`). The route plugin
 * (`routes/tasks.ts`) is the only caller; task_created / task_completed events
 * flow through the ActivityWriter, which maintains `leads.next_task_due_at`.
 */
export {
  TaskError,
  TaskNotFoundError,
  TaskLeadNotFoundError,
  InvalidTaskReferenceError,
  serializeTask,
  listTasks,
  getTask,
  createTask,
  patchTask,
  deleteTask,
  type ListTasksFilter,
  type CreateTaskInput,
  type PatchTaskInput,
} from './service.ts';
