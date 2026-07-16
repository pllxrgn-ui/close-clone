/*
 * Live preview of the current Smart View. THIS COMPONENT IS THE SEAM: at merge,
 * the shared leads-track table replaces the simple table below, keeping the same
 * props ({ dsl, statusLabels, userNames }). It debounces DSL changes and calls
 * POST /smart-views/preview for a count-estimate + first page (C7). The DSL is
 * always the builder's canonical serialization, so preview requests exercise the
 * real parse→compile path (the mock validates the DSL and 400s on a bad parse).
 */
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Ast, Lead } from '@switchboard/shared';
import { astToDsl } from '@switchboard/shared';
import { ApiError } from '../../api/errors.ts';
import { previewSmartView } from '../../api/smartViews.ts';
import { EmptyState, Spinner, StatusPill } from '../../ui/index.ts';

const PREVIEW_LIMIT = 8;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export interface PreviewPaneProps {
  /** The current view's AST, or null when the view is empty. Sent to the preview
   *  endpoint as `ast` (not `dsl`) so custom-field views validate against the
   *  server's catalog rather than the mock's catalog-less `dsl` parse. */
  ast: Ast | null;
  statusLabels: ReadonlyMap<string, string>;
  userNames: ReadonlyMap<string, string>;
  debounceMs?: number;
}

export function PreviewPane({
  ast,
  statusLabels,
  userNames,
  debounceMs = 300,
}: PreviewPaneProps): JSX.Element {
  // Key on the canonical DSL so identical views dedupe; send the AST.
  const dsl = ast ? astToDsl(ast) : null;
  const debouncedKey = useDebounced(dsl, debounceMs);
  const stableAst = useDebounced(ast, debounceMs);

  const query = useQuery({
    queryKey: ['smart-view-preview', debouncedKey],
    queryFn: () => previewSmartView({ ast: stableAst ?? undefined, limit: PREVIEW_LIMIT }),
    enabled: debouncedKey !== null,
    retry: false,
    placeholderData: keepPreviousData,
  });

  return (
    <section className="sb-vb-preview" aria-label="Live preview">
      <header className="sb-vb-preview__head">
        <h2 className="sb-vb-preview__title">Preview</h2>
        <PreviewCount
          empty={dsl === null}
          loading={query.isFetching}
          count={query.data?.countEstimate}
          error={query.isError}
        />
      </header>
      <PreviewBody dsl={dsl} query={query} statusLabels={statusLabels} userNames={userNames} />
    </section>
  );
}

function PreviewCount({
  empty,
  loading,
  count,
  error,
}: {
  empty: boolean;
  loading: boolean;
  count: number | undefined;
  error: boolean;
}): JSX.Element {
  if (empty) return <span className="sb-vb-preview__count sb-vb-preview__count--muted">—</span>;
  if (error) return <span className="sb-vb-preview__count sb-vb-preview__count--muted">—</span>;
  return (
    <span className="sb-vb-preview__count" aria-live="polite">
      {count === undefined ? (
        <span className="sb-vb-preview__count-dim">counting…</span>
      ) : (
        <>
          <span className="sb-vb-preview__count-num">≈{count.toLocaleString()}</span> leads
        </>
      )}
      {loading ? <Spinner label="Updating preview" /> : null}
    </span>
  );
}

function PreviewBody({
  dsl,
  query,
  statusLabels,
  userNames,
}: {
  dsl: string | null;
  query: ReturnType<typeof useQuery<{ items: Lead[]; countEstimate: number }>>;
  statusLabels: ReadonlyMap<string, string>;
  userNames: ReadonlyMap<string, string>;
}): JSX.Element {
  if (dsl === null) {
    return (
      <EmptyState
        title="Nothing to preview yet"
        description="Add a condition to see matching leads."
      />
    );
  }
  if (query.isError) {
    const message =
      query.error instanceof ApiError ? query.error.message : 'The preview request failed.';
    return <EmptyState title="Preview unavailable" description={message} />;
  }
  const items = query.data?.items ?? [];
  if (query.isLoading && items.length === 0) {
    return (
      <div className="sb-vb-preview__loading">
        <Spinner size="lg" label="Loading preview" />
      </div>
    );
  }
  if (items.length === 0) {
    return <EmptyState title="No matching leads" description="No leads match this view." />;
  }

  return (
    <div className="sb-vb-preview__tablewrap">
      <table className="sb-vb-preview__table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Owner</th>
            <th scope="col">Last contacted</th>
          </tr>
        </thead>
        <tbody>
          {items.map((lead) => (
            <tr key={lead.id}>
              <td className="sb-vb-preview__name">
                <span className="sb-vb-preview__name-text">{lead.name}</span>
                {lead.dnc ? (
                  <StatusPill tone="dnc" dot>
                    DNC
                  </StatusPill>
                ) : null}
              </td>
              <td>{(lead.statusId && statusLabels.get(lead.statusId)) || '—'}</td>
              <td>{(lead.ownerId && userNames.get(lead.ownerId)) || '—'}</td>
              <td className="sb-vb-preview__num">{formatDate(lead.lastContactedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sb-vb-preview__note">
        Showing the first {items.length}. The full results table lands with the leads track.
      </p>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
