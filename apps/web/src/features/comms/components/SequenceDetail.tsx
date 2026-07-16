import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, EmptyState, Lamp, Spinner, StatusPill } from '../../../ui/index.ts';
import {
  listSequenceRoster,
  listSequences,
  listSequenceSteps,
  listTemplates,
  setEnrollmentState,
} from '../api/comms.ts';
import type { EnrollmentRow } from '../api/comms.ts';
import { StepLadder, ReviewNote } from './StepLadder.tsx';
import { ReplyPausesCallout } from './ReplyPausesCallout.tsx';
import { EnrollDrawer } from './EnrollDrawer.tsx';
import { ArrowLeftIcon, PauseIcon, PlayIcon, UserPlusIcon } from '../icons.tsx';

/*
 * Sequence detail (/sequences/:id): the step ladder, the reply-pauses-everything
 * compliance callout, and the enrolled roster with per-row pause/resume. Enroll
 * and pause/resume mutate the store; the counts here and on the list re-render
 * off invalidated queries.
 */
export function SequenceDetail({ sequenceId }: { sequenceId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [enrollOpen, setEnrollOpen] = useState(false);

  const sequencesQuery = useQuery({
    queryKey: ['comms', 'sequences'],
    queryFn: () => listSequences(),
  });
  const stepsQuery = useQuery({
    queryKey: ['comms', 'steps', sequenceId],
    queryFn: () => listSequenceSteps(sequenceId),
  });
  const rosterQuery = useQuery({
    queryKey: ['comms', 'roster', sequenceId],
    queryFn: () => listSequenceRoster(sequenceId),
  });
  const templatesQuery = useQuery({
    queryKey: ['comms', 'templates'],
    queryFn: () => listTemplates(),
  });

  const templateName = useMemo(() => {
    const byId = new Map((templatesQuery.data ?? []).map((t) => [t.id, t.name]));
    return (id: string | null): string | null => (id ? (byId.get(id) ?? null) : null);
  }, [templatesQuery.data]);

  const roster = rosterQuery.data ?? [];
  const activeCount = roster.filter((r) => r.state === 'active').length;
  const pausedCount = roster.filter((r) => r.state === 'paused').length;

  const stateMutation = useMutation({
    mutationFn: (input: { id: string; state: 'active' | 'paused' }) =>
      setEnrollmentState(input.id, { state: input.state, pausedReason: 'manual' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['comms', 'roster', sequenceId] });
      void queryClient.invalidateQueries({ queryKey: ['comms', 'enrollments', 'all'] });
    },
  });

  const refreshAfterEnroll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['comms', 'roster', sequenceId] });
    void queryClient.invalidateQueries({ queryKey: ['comms', 'enrollments', 'all'] });
  };

  if (sequencesQuery.isLoading) {
    return (
      <div className="seq-page seq-page--center" role="status">
        <Spinner size="lg" label="Loading sequence" />
      </div>
    );
  }

  const sequence = (sequencesQuery.data ?? []).find((s) => s.id === sequenceId);
  if (!sequence) {
    return (
      <div className="seq-page">
        <EmptyState
          title="Sequence not found"
          description="It may have been archived or removed."
          actions={
            <Link className="sb-btn" to="/sequences">
              Back to sequences
            </Link>
          }
        />
      </div>
    );
  }

  const active = sequence.status === 'active';

  return (
    <div className="seq-page">
      <header className="seq-detail__head">
        <Link to="/sequences" className="comms-backlink" aria-label="Back to sequences">
          <ArrowLeftIcon size={14} /> Sequences
        </Link>
        <div className="seq-detail__title-row">
          <h1 className="seq-page__title">{sequence.name}</h1>
          <StatusPill tone={active ? 'inSequence' : 'lost'}>{sequence.status}</StatusPill>
          <span className="seq-detail__counts">
            <span className="seq-row__count">
              <Lamp state="seq" decorative size={8} pulse={false} />
              <b>{activeCount}</b> active
            </span>
            <span className="seq-row__count seq-row__count--muted">
              <Lamp state="idle" decorative size={8} />
              <b>{pausedCount}</b> paused
            </span>
          </span>
          <div className="seq-detail__actions">
            <Button
              variant="primary"
              onClick={() => setEnrollOpen(true)}
              disabled={!active}
              {...(!active ? { title: 'Archived sequences can’t take new enrollments' } : {})}
            >
              <UserPlusIcon size={14} /> Enroll
            </Button>
          </div>
        </div>
      </header>

      <ReplyPausesCallout />

      <div className="seq-detail__grid">
        <section className="seq-panel" aria-label="Steps">
          <h2 className="seq-panel__title">Step ladder</h2>
          {stepsQuery.isLoading ? (
            <div className="comms-drawer__loading" role="status">
              <Spinner label="Loading steps" />
            </div>
          ) : (
            <>
              <StepLadder steps={stepsQuery.data ?? []} templateName={templateName} />
              <ReviewNote />
            </>
          )}
        </section>

        <section className="seq-panel" aria-label="Enrolled contacts">
          <h2 className="seq-panel__title">
            Enrolled
            <span className="seq-panel__count">{roster.length}</span>
          </h2>
          {rosterQuery.isLoading ? (
            <div className="comms-drawer__loading" role="status">
              <Spinner label="Loading enrollments" />
            </div>
          ) : roster.length === 0 ? (
            <EmptyState
              title="No one enrolled yet"
              description="Enroll a contact to start the sequence."
            />
          ) : (
            <ul className="roster" aria-label="Enrolled contacts">
              {roster.map((row) => (
                <RosterRow
                  key={row.id}
                  row={row}
                  busy={stateMutation.isPending}
                  onToggle={(next) => stateMutation.mutate({ id: row.id, state: next })}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <EnrollDrawer
        open={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        sequenceId={sequenceId}
        sequenceName={sequence.name}
        onEnrolled={refreshAfterEnroll}
      />
    </div>
  );
}

function RosterRow({
  row,
  busy,
  onToggle,
}: {
  row: EnrollmentRow;
  busy: boolean;
  onToggle: (next: 'active' | 'paused') => void;
}): JSX.Element {
  const paused = row.state === 'paused';
  return (
    <li className="roster__row" data-accent="">
      <span className="roster__rail" data-state={paused ? 'paused' : 'active'} aria-hidden="true" />
      <span className="roster__who">
        <span className="roster__name">{row.contactName}</span>
        <span className="roster__lead">{row.leadName}</span>
      </span>
      <span className="roster__email">{row.contactEmail}</span>
      <span className="roster__state">
        {paused ? (
          <StatusPill tone="draft" dot>
            Paused{row.pausedReason ? ` · ${row.pausedReason}` : ''}
          </StatusPill>
        ) : (
          <StatusPill tone="inSequence" dot>
            Active
          </StatusPill>
        )}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => onToggle(paused ? 'active' : 'paused')}
        aria-label={paused ? `Resume ${row.contactName}` : `Pause ${row.contactName}`}
      >
        {paused ? (
          <>
            <PlayIcon size={13} /> Resume
          </>
        ) : (
          <>
            <PauseIcon size={13} /> Pause
          </>
        )}
      </Button>
    </li>
  );
}
