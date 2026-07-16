import { useMemo } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  EmptyState,
  Lamp,
  LampRail,
  ListRow,
  Spinner,
  StatusPill,
} from '../../../ui/index.ts';
import { ApiError } from '../../../api/index.ts';
import { listSequenceEnrollments, listSequences, listSequenceSteps } from '../api/comms.ts';
import { BranchIcon, ChevronRightIcon } from '../icons.tsx';

/*
 * The sequences list surface (/sequences). Each row shows the sequence, its
 * status, step count, and live active/paused enrollment counts (grouped from one
 * enrollments fetch, so the numbers re-render after an enroll/pause). Keyboard-
 * operable rows (ListRow renders a real button) route to the detail ladder.
 */
export function SequencesList(): JSX.Element {
  const navigate = useNavigate();
  const sequencesQuery = useQuery({
    queryKey: ['comms', 'sequences'],
    queryFn: () => listSequences(),
  });
  const stepsQuery = useQuery({
    queryKey: ['comms', 'steps', 'all'],
    queryFn: () => listSequenceSteps(),
  });
  const enrollmentsQuery = useQuery({
    queryKey: ['comms', 'enrollments', 'all'],
    queryFn: () => listSequenceEnrollments(),
  });

  const stepCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of stepsQuery.data ?? []) map.set(s.sequenceId, (map.get(s.sequenceId) ?? 0) + 1);
    return map;
  }, [stepsQuery.data]);

  const counts = useMemo(() => {
    const map = new Map<string, { active: number; paused: number }>();
    for (const e of enrollmentsQuery.data ?? []) {
      const cur = map.get(e.sequenceId) ?? { active: 0, paused: 0 };
      if (e.state === 'active') cur.active += 1;
      else if (e.state === 'paused') cur.paused += 1;
      map.set(e.sequenceId, cur);
    }
    return map;
  }, [enrollmentsQuery.data]);

  if (sequencesQuery.isLoading) {
    return (
      <div className="seq-page seq-page--center" role="status">
        <Spinner size="lg" label="Loading sequences" />
      </div>
    );
  }
  if (sequencesQuery.isError) {
    const msg =
      sequencesQuery.error instanceof ApiError
        ? `${sequencesQuery.error.message} (${sequencesQuery.error.code})`
        : 'Something went wrong.';
    return (
      <div className="seq-page">
        <EmptyState
          title="Couldn’t load sequences"
          description={msg}
          actions={<Button onClick={() => void sequencesQuery.refetch()}>Retry</Button>}
        />
      </div>
    );
  }

  const sequences = sequencesQuery.data ?? [];

  return (
    <div className="seq-page">
      <header className="seq-page__head">
        <div className="seq-page__title-wrap">
          <h1 className="seq-page__title">
            <BranchIcon size={20} /> Sequences
          </h1>
          <p className="seq-page__subtitle">
            {sequences.length} sequence{sequences.length === 1 ? '' : 's'} · reply pauses everything
          </p>
        </div>
      </header>

      {sequences.length === 0 ? (
        <EmptyState
          title="No sequences yet"
          description="Create a sequence to start automating outreach."
        />
      ) : (
        <ul className="seq-list" aria-label="Sequences">
          {sequences.map((seq) => {
            const active = seq.status === 'active';
            const c = counts.get(seq.id) ?? { active: 0, paused: 0 };
            const steps = stepCounts.get(seq.id) ?? 0;
            return (
              <li key={seq.id}>
                <ListRow
                  className="seq-row"
                  onSelect={() => navigate(`/sequences/${seq.id}`)}
                  ariaLabel={`${seq.name}, ${seq.status}, ${steps} steps, ${c.active} active, ${c.paused} paused`}
                >
                  <LampRail state={active ? 'seq' : 'idle'} decorative />
                  <span className="seq-row__name">{seq.name}</span>
                  <StatusPill tone={active ? 'inSequence' : 'lost'}>{seq.status}</StatusPill>
                  <span className="seq-row__steps">{steps} steps</span>
                  <span className="seq-row__counts">
                    <span className="seq-row__count">
                      <Lamp state="seq" decorative size={7} pulse={false} />
                      <b>{c.active}</b> active
                    </span>
                    <span className="seq-row__count seq-row__count--muted">
                      <Lamp state="idle" decorative size={7} />
                      <b>{c.paused}</b> paused
                    </span>
                  </span>
                  <ChevronRightIcon size={16} className="seq-row__chevron" />
                </ListRow>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
