import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Lead, SmartView } from '@switchboard/shared';
import { ApiError } from '../../../api/index.ts';
import { listLeads } from '../../../api/leads.ts';
import { listSmartViews, getSmartView, previewSmartView } from '../../../api/smartViews.ts';
import { listLeadStatuses, listUsers } from '../../../api/reference.ts';
import { EmptyState, Spinner, Skeleton, Button, Input } from '../../../ui/index.ts';
import { SearchIcon, XIcon } from '../icons.tsx';
import { usePrefersReducedMotion } from '../lib/useReducedMotion.ts';
import { compareByColumn, resolveColumns } from '../columns/columns.tsx';
import type { ColumnCtx, ColumnDef } from '../columns/columns.tsx';
import { LeadsTable } from './LeadsTable.tsx';
import type { SortState } from './LeadsTable.tsx';
import { SmartViewsSidebar } from './SmartViewsSidebar.tsx';
import { BulkBar } from './BulkBar.tsx';

const PAGE_LIMIT = 100;

interface LeadsSurfaceProps {
  /** null → the "All leads" surface (/leads); a view id → /views/:id. */
  viewId: string | null;
}

function parseViewSort(view: SmartView | undefined, columns: ColumnDef[]): SortState | null {
  const sort = view?.sort;
  if (!sort || typeof sort !== 'object') return null;
  const record = sort as Record<string, unknown>;
  const field = record.field;
  const dir = record.dir;
  if (typeof field !== 'string') return null;
  const col = columns.find((c) => c.key === field);
  if (!col || !col.sortable) return null;
  return { key: field, dir: dir === 'asc' ? 'asc' : 'desc' };
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return 'Something went wrong.';
}

export function LeadsSurface({ viewId }: LeadsSurfaceProps): JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const reducedMotion = usePrefersReducedMotion();
  const now = useMemo(() => new Date(), []);

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [sort, setSort] = useState<SortState | null>(null);

  // ── Reference data (D-023 endpoints) → owner/status label maps ────────────
  const usersQuery = useQuery({ queryKey: ['ref', 'users'], queryFn: () => listUsers() });
  const statusesQuery = useQuery({
    queryKey: ['ref', 'lead-statuses'],
    queryFn: () => listLeadStatuses(),
  });

  const ctx = useMemo<ColumnCtx>(() => {
    const userById = new Map((usersQuery.data ?? []).map((u) => [u.id, u.name]));
    const statusById = new Map((statusesQuery.data ?? []).map((s) => [s.id, s.label]));
    return {
      statusLabel: (id) => (id ? (statusById.get(id) ?? '—') : '—'),
      ownerName: (id) => (id ? (userById.get(id) ?? '—') : '—'),
      now,
    };
  }, [usersQuery.data, statusesQuery.data, now]);

  // ── Smart views (sidebar list + active view meta) ─────────────────────────
  const viewsQuery = useQuery({ queryKey: ['smart-views'], queryFn: () => listSmartViews() });
  const activeViewQuery = useQuery({
    queryKey: ['smart-view', viewId],
    queryFn: () => getSmartView(viewId as string),
    enabled: viewId !== null,
  });
  const activeView = activeViewQuery.data;

  const columns = useMemo(
    () => resolveColumns(viewId ? (activeView?.columns ?? null) : null),
    [viewId, activeView?.columns],
  );

  // ── Rows: preview for a view, keyset-paginated list for "All leads" ───────
  const previewQuery = useQuery({
    queryKey: ['smart-view-preview', viewId, activeView?.dsl],
    queryFn: () => previewSmartView({ dsl: activeView?.dsl ?? '' }),
    enabled: viewId !== null && activeView !== undefined,
  });

  const allLeadsQuery = useInfiniteQuery({
    queryKey: ['leads', 'all'],
    queryFn: ({ pageParam }) =>
      listLeads(pageParam ? { cursor: pageParam, limit: PAGE_LIMIT } : { limit: PAGE_LIMIT }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: viewId === null,
  });

  const rawRows: Lead[] = viewId
    ? (previewQuery.data?.items ?? [])
    : (allLeadsQuery.data?.pages.flatMap((p) => p.items) ?? []);

  // Adopt the view's declared sort (or clear for All leads) + reset selection
  // whenever the active view changes — this is where a view switch re-queries.
  useEffect(() => {
    setSort(viewId ? parseViewSort(activeView, columns) : null);
    setSelected(new Set());
  }, [viewId, activeView, columns]);

  // ── Client-side sort + text filter over loaded rows ───────────────────────
  const sortedRows = useMemo(() => {
    if (!sort) return rawRows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col || !col.sortable) return rawRows;
    return [...rawRows].sort(compareByColumn(col, sort.dir, ctx));
  }, [rawRows, sort, columns, ctx]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return sortedRows;
    return sortedRows.filter((lead) => {
      const inName = lead.name.toLowerCase().includes(term);
      const inDesc = lead.description?.toLowerCase().includes(term) ?? false;
      const inStatus = ctx.statusLabel(lead.statusId).toLowerCase().includes(term);
      const inOwner = ctx.ownerName(lead.ownerId).toLowerCase().includes(term);
      return inName || inDesc || inStatus || inOwner;
    });
  }, [sortedRows, q, ctx]);

  // ── Selection helpers ─────────────────────────────────────────────────────
  const selectedInView = rows.filter((l) => selected.has(l.id)).length;
  const selectAllState: 'all' | 'some' | 'none' =
    selectedInView === 0 ? 'none' : selectedInView === rows.length ? 'all' : 'some';

  const toggleSelect = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleSelectAll = (): void =>
    setSelected((prev) => {
      const allSelected = rows.length > 0 && rows.every((l) => prev.has(l.id));
      return allSelected ? new Set() : new Set(rows.map((l) => l.id));
    });

  const setQuery = (value: string): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set('q', value);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  };

  // ── Table-area status flags ───────────────────────────────────────────────
  const refLoading = usersQuery.isLoading || statusesQuery.isLoading;
  const dataError = viewId ? (activeViewQuery.error ?? previewQuery.error) : allLeadsQuery.error;
  const dataLoading = viewId
    ? activeViewQuery.isLoading || previewQuery.isLoading
    : allLeadsQuery.isLoading;
  const busy = refLoading || dataLoading;

  const countEstimate = viewId ? previewQuery.data?.countEstimate : undefined;
  const viewName = viewId ? (activeView?.name ?? 'View') : 'All leads';

  return (
    <div className="leads-surface" data-reduced-motion={reducedMotion ? 'true' : undefined}>
      <SmartViewsSidebar
        views={viewsQuery.data ?? []}
        activeViewId={viewId}
        onSelect={(id) => navigate(id ? `/views/${id}` : '/leads')}
        isLoading={viewsQuery.isLoading}
        isError={viewsQuery.isError}
        {...(viewsQuery.error ? { errorMessage: errorMessage(viewsQuery.error) } : {})}
        onRetry={() => void viewsQuery.refetch()}
      />

      <section className="leads-main" aria-label={`Leads — ${viewName}`}>
        <header className="leads-toolbar">
          <div className="leads-toolbar__title">
            <h1 className="leads-toolbar__name">{viewName}</h1>
            <span className="leads-toolbar__count" aria-live="polite">
              {busy ? (
                <Skeleton width={64} height={12} />
              ) : countEstimate !== undefined ? (
                `≈ ${countEstimate.toLocaleString('en-US')}`
              ) : (
                `${rows.length.toLocaleString('en-US')}${allLeadsQuery.hasNextPage ? '+' : ''} leads`
              )}
            </span>
            {viewId && activeView?.dsl ? (
              <code className="leads-toolbar__dsl" title="Smart View query">
                {activeView.dsl}
              </code>
            ) : null}
          </div>

          <div className="leads-toolbar__filter">
            <SearchIcon size={15} className="leads-toolbar__filter-icon" />
            <Input
              type="search"
              aria-label="Filter these leads"
              placeholder="Filter…"
              value={q}
              onChange={(e) => setQuery(e.target.value)}
              className="leads-toolbar__filter-input"
            />
            {q ? (
              <button
                type="button"
                className="leads-toolbar__filter-clear"
                aria-label="Clear filter"
                onClick={() => setQuery('')}
              >
                <XIcon size={14} />
              </button>
            ) : null}
          </div>
        </header>

        <div className="leads-content">
          {dataError ? (
            <EmptyState
              title="Couldn’t load leads"
              description={errorMessage(dataError)}
              actions={
                <Button
                  onClick={() => void (viewId ? previewQuery.refetch() : allLeadsQuery.refetch())}
                >
                  Retry
                </Button>
              }
            />
          ) : busy && rawRows.length === 0 ? (
            <div className="leads-content__loading">
              <TableSkeleton />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title={q ? 'No matches' : viewId ? 'No leads in this view' : 'No leads yet'}
              description={
                q
                  ? `Nothing matches “${q.trim()}”.`
                  : viewId
                    ? 'No leads currently match this Smart View.'
                    : 'Leads will appear here as they’re created or imported.'
              }
              {...(q
                ? { actions: <Button onClick={() => setQuery('')}>Clear filter</Button> }
                : {})}
            />
          ) : (
            <LeadsTable
              leads={rows}
              columns={columns}
              ctx={ctx}
              sort={sort}
              onSortChange={(key) =>
                setSort((s) =>
                  s?.key === key
                    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
                    : { key, dir: 'asc' },
                )
              }
              selectedIds={selected}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
              selectAllState={selectAllState}
              onOpen={(lead) => navigate(`/leads/${lead.id}`)}
              now={now}
              reducedMotion={reducedMotion}
              {...(countEstimate !== undefined ? { totalCount: countEstimate } : {})}
              {...(viewId
                ? {}
                : {
                    hasMore: allLeadsQuery.hasNextPage ?? false,
                    onLoadMore: () => {
                      void allLeadsQuery.fetchNextPage();
                    },
                    loadingMore: allLeadsQuery.isFetchingNextPage,
                  })}
            />
          )}
        </div>

        <BulkBar
          count={selected.size}
          onClear={() => setSelected(new Set())}
          selectedLeads={rows.filter((l) => selected.has(l.id))}
        />
      </section>
    </div>
  );
}

function TableSkeleton(): JSX.Element {
  return (
    <div className="leads-skeleton" aria-hidden="true">
      <Spinner label="Loading leads" />
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} height={28} className="leads-skeleton__row" />
      ))}
    </div>
  );
}
