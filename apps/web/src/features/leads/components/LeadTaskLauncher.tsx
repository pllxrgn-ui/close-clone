import { useId, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Lead } from '@switchboard/shared';
import { Button, Field, IconButton, Input, Modal, CloseIcon } from '../../../ui/index.ts';
import { ApiError } from '../../../api/index.ts';
import { createTask } from '../../../api/tasks.ts';
import { useAuth } from '../../../auth/AuthProvider.tsx';
import { useToast } from '../../../feedback/index.ts';
import { CircleDashedIcon } from '../icons.tsx';

/*
 * The lead-page "Task" next-action (replaces the last disabled stub). Opens a
 * small centered modal — title (required) + optional due date — and creates the
 * task through the real C7 route (`POST /tasks`), assigned to the current user.
 * The engine lands a task_created activity, so on success the timeline and the
 * lead's next-task column refresh in place.
 */

const DUE_PRESETS = [
  { label: 'Today', days: 0 },
  { label: 'Tomorrow', days: 1 },
  { label: 'Next week', days: 7 },
] as const;

/** Local calendar date `days` from now, in the date-input's YYYY-MM-DD form. */
function presetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

export function LeadTaskLauncher({ lead }: { lead: Lead }): JSX.Element {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const titleRef = useRef<HTMLInputElement | null>(null);
  const headingId = useId();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');

  function close(): void {
    setOpen(false);
    setTitle('');
    setDue('');
    mutation.reset();
  }

  const mutation = useMutation({
    mutationFn: () =>
      createTask({
        leadId: lead.id,
        title: title.trim(),
        ...(user?.id ? { assigneeId: user.id } : {}),
        // Date-only input → due at 9:00 local that day (a workday-start default).
        dueAt: due !== '' ? new Date(`${due}T09:00:00`).toISOString() : null,
      }),
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: ['lead-timeline', lead.id] });
      void queryClient.invalidateQueries({ queryKey: ['lead', lead.id] });
      toast(`Task created — ${task.title}`);
      close();
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Could not create the task');
    },
  });

  const canCreate = title.trim().length > 0 && !mutation.isPending;

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} title={`New task for ${lead.name}`}>
        <CircleDashedIcon size={14} /> Task
      </Button>
      <Modal
        open={open}
        onClose={close}
        labelledBy={headingId}
        initialFocusRef={titleRef}
        className="lead-newtask"
        backdropClassName="sb-overlay--center"
      >
        <form
          className="lead-newtask__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) mutation.mutate();
          }}
        >
          <header className="lead-newtask__head">
            <h2 id={headingId} className="lead-newtask__title">
              <CircleDashedIcon size={15} /> New task · {lead.name}
            </h2>
            <IconButton label="Close" size="sm" onClick={close}>
              <CloseIcon size={16} />
            </IconButton>
          </header>

          <Field label="Title" required>
            <Input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Send the revised quote"
              maxLength={500}
            />
          </Field>

          <Field label="Due date" hint={user ? `Assigned to ${user.name}` : undefined}>
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <div className="lead-newtask__presets" role="group" aria-label="Due date presets">
            {DUE_PRESETS.map((preset) => {
              const value = presetDate(preset.days);
              return (
                <Button
                  key={preset.label}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={due === value}
                  onClick={() => setDue(value)}
                >
                  {preset.label}
                </Button>
              );
            })}
          </div>

          <footer className="lead-newtask__foot">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!canCreate}
              loading={mutation.isPending}
            >
              Create task
            </Button>
          </footer>
        </form>
      </Modal>
    </>
  );
}
