import { useMemo } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../../api/index.ts';
import { getLead, getLeadTimeline } from '../../../api/leads.ts';
import { listLeadStatuses, listUsers } from '../../../api/reference.ts';
import { Button, EmptyState, Spinner } from '../../../ui/index.ts';
import {
  listLeadContacts,
  listLeadOpportunities,
  listOpportunityStages,
} from '../api/leadDetail.ts';
import { LeadHeader } from './LeadHeader.tsx';
import { Timeline } from './Timeline.tsx';
import { LeadContactsCard } from './LeadContactsCard.tsx';
import { LeadOpportunitiesCard } from './LeadOpportunitiesCard.tsx';

/*
 * The lead page: header (identity/status/owner/DNC/next-action placeholder), a
 * center C4 timeline (keyset load-older), and a read-only right rail of contacts
 * and opportunities. Every fetch has C8-typed loading/error/empty states.
 */

const TIMELINE_PAGE = 25;

function describeError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return 'Something went wrong.';
}

interface LeadDetailProps {
  leadId: string;
}

export function LeadDetail({ leadId }: LeadDetailProps): JSX.Element {
  const now = useMemo(() => new Date(), []);

  const usersQuery = useQuery({ queryKey: ['ref', 'users'], queryFn: () => listUsers() });
  const statusesQuery = useQuery({
    queryKey: ['ref', 'lead-statuses'],
    queryFn: () => listLeadStatuses(),
  });
  const stagesQuery = useQuery({
    queryKey: ['ref', 'opportunity-stages'],
    queryFn: () => listOpportunityStages(),
  });

  const leadQuery = useQuery({ queryKey: ['lead', leadId], queryFn: () => getLead(leadId) });
  const timelineQuery = useInfiniteQuery({
    queryKey: ['lead-timeline', leadId],
    queryFn: ({ pageParam }) =>
      getLeadTimeline(
        leadId,
        pageParam ? { cursor: pageParam, limit: TIMELINE_PAGE } : { limit: TIMELINE_PAGE },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const contactsQuery = useQuery({
    queryKey: ['lead-contacts', leadId],
    queryFn: () => listLeadContacts(leadId),
  });
  const oppsQuery = useQuery({
    queryKey: ['lead-opportunities', leadId],
    queryFn: () => listLeadOpportunities(leadId),
  });

  const userName = useMemo(() => {
    const byId = new Map((usersQuery.data ?? []).map((u) => [u.id, u.name]));
    return (id: string | null): string => (id ? (byId.get(id) ?? '—') : '—');
  }, [usersQuery.data]);
  const statusLabel = useMemo(() => {
    const byId = new Map((statusesQuery.data ?? []).map((s) => [s.id, s.label]));
    return (id: string | null): string => (id ? (byId.get(id) ?? '—') : '—');
  }, [statusesQuery.data]);
  const stageLabel = useMemo(() => {
    const byId = new Map((stagesQuery.data ?? []).map((s) => [s.id, s.label]));
    return (id: string | null): string => (id ? (byId.get(id) ?? '—') : '—');
  }, [stagesQuery.data]);

  if (leadQuery.isLoading) {
    return (
      <div className="lead-detail lead-detail--loading" role="status">
        <Spinner size="lg" label="Loading lead" />
      </div>
    );
  }

  if (leadQuery.isError || !leadQuery.data) {
    const notFound = leadQuery.error instanceof ApiError && leadQuery.error.code === 'NOT_FOUND';
    return (
      <div className="lead-detail">
        <EmptyState
          title={notFound ? 'Lead not found' : 'Couldn’t load this lead'}
          description={
            notFound ? 'It may have been merged or deleted.' : describeError(leadQuery.error)
          }
          actions={
            notFound ? (
              <Link className="sb-btn" to="/leads">
                Back to leads
              </Link>
            ) : (
              <Button onClick={() => void leadQuery.refetch()}>Retry</Button>
            )
          }
        />
      </div>
    );
  }

  const lead = leadQuery.data;
  const events = timelineQuery.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="lead-detail">
      <LeadHeader
        lead={lead}
        statusLabel={statusLabel(lead.statusId)}
        ownerName={userName(lead.ownerId)}
      />

      <div className="lead-detail__body">
        <main className="lead-detail__center" aria-label="Activity timeline">
          <Timeline
            events={events}
            userName={userName}
            now={now}
            isLoading={timelineQuery.isLoading}
            isError={timelineQuery.isError}
            {...(timelineQuery.error ? { errorMessage: describeError(timelineQuery.error) } : {})}
            onRetry={() => void timelineQuery.refetch()}
            hasMore={timelineQuery.hasNextPage ?? false}
            onLoadMore={() => void timelineQuery.fetchNextPage()}
            loadingMore={timelineQuery.isFetchingNextPage}
          />
        </main>

        <aside className="lead-detail__rail" aria-label="Contacts and opportunities">
          <LeadContactsCard
            contacts={contactsQuery.data ?? []}
            isLoading={contactsQuery.isLoading}
            isError={contactsQuery.isError}
            onRetry={() => void contactsQuery.refetch()}
          />
          <LeadOpportunitiesCard
            opportunities={oppsQuery.data ?? []}
            stageLabel={stageLabel}
            isLoading={oppsQuery.isLoading}
            isError={oppsQuery.isError}
            onRetry={() => void oppsQuery.refetch()}
          />
        </aside>
      </div>
    </div>
  );
}
