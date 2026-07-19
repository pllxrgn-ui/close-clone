import { useMemo } from 'react';
import type { JSX } from 'react';
import type { Activity } from '@switchboard/shared';
import { Button, EmptyState, ErrorState, Spinner } from '../../../ui/index.ts';
import { ClockIcon } from '../icons.tsx';
import { formatDayLabel, localDayKey } from '../lib/format.ts';
import { TimelineEvent } from './TimelineEvent.tsx';

/*
 * The lead's activity spine (CONTRACTS §C4), newest-first, grouped by day with
 * sticky day headings and keyset "load older". Presentational: the lead page owns
 * the keyset GET /leads/:id/timeline query and passes state down.
 */

export interface DayGroup {
  key: string;
  label: string;
  events: Activity[];
}

/** Group an already-ordered (newest-first) event list into contiguous day runs. */
export function groupEventsByDay(events: Activity[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const event of events) {
    const key = localDayKey(event.occurredAt);
    if (!current || current.key !== key) {
      current = { key, label: formatDayLabel(event.occurredAt, now), events: [] };
      groups.push(current);
    }
    current.events.push(event);
  }
  return groups;
}

interface TimelineProps {
  events: Activity[];
  userName: (id: string | null) => string;
  contactName?: (id: string | null) => string;
  now: Date;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
}

export function Timeline({
  events,
  userName,
  contactName,
  now,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  hasMore,
  onLoadMore,
  loadingMore,
}: TimelineProps): JSX.Element {
  const groups = useMemo(() => groupEventsByDay(events, now), [events, now]);

  if (isLoading) {
    return (
      <div className="tl-status">
        <Spinner label="Loading timeline" />
      </div>
    );
  }

  if (isError) {
    return (
      <ErrorState
        title="Couldn’t load the timeline"
        description={errorMessage ?? 'The request failed.'}
        onRetry={onRetry}
      />
    );
  }

  if (events.length === 0) {
    return (
      <EmptyState
        icon={<ClockIcon size={22} />}
        title="No activity yet"
        description="Calls, emails, notes, and other events will appear here."
      />
    );
  }

  return (
    <div className="tl-wrap">
      <ol className="tl">
        {groups.map((group) => (
          <li key={group.key} className="tl-day">
            <div className="tl-day__label">
              <span className="tl-day__label-text">{group.label}</span>
            </div>
            <ol className="tl-day__events">
              {group.events.map((event) => (
                <TimelineEvent
                  key={event.id}
                  activity={event}
                  userName={userName}
                  {...(contactName ? { contactName } : {})}
                  now={now}
                />
              ))}
            </ol>
          </li>
        ))}
      </ol>

      {loadingMore ? (
        <div className="tl-more">
          <Spinner label="Loading older activity" />
          <span>Loading older…</span>
        </div>
      ) : hasMore ? (
        <div className="tl-more">
          <Button variant="ghost" size="sm" onClick={onLoadMore}>
            Load older activity
          </Button>
        </div>
      ) : (
        <div className="tl-end" aria-hidden="true">
          Beginning of history
        </div>
      )}
    </div>
  );
}
