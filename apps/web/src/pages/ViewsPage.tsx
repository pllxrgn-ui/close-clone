import type { JSX } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { cx } from '../lib/cx.ts';
import { listSmartViews } from '../api/smartViews.ts';
import { useListNav, KbdCombo } from '../keyboard/index.ts';
import { EmptyState, Spinner, StatusPill } from '../ui/index.ts';
import { Page } from './Page.tsx';

export function ViewsPage(): JSX.Element {
  const navigate = useNavigate();
  const {
    data: views = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['smart-views'],
    queryFn: listSmartViews,
  });
  const nav = useListNav({
    count: views.length,
    onActivate: (index) => {
      const view = views[index];
      if (view) navigate(`/views/${view.id}`);
    },
  });

  return (
    <Page title="Views" subtitle="Saved lead segments powered by the Smart View query language.">
      <section className="sb-views" aria-label="Saved Smart Views">
        <header className="sb-views__head">
          <h2 className="sb-views__title">Saved views</h2>
          <span className="sb-views__hint" aria-hidden="true">
            <KbdCombo combo="j" />
            <KbdCombo combo="k" />
            <span>move</span>
            <KbdCombo combo="enter" />
            <span>open</span>
          </span>
          <Link className="sb-btn sb-btn--primary" to="/views/new">
            New view
          </Link>
        </header>

        {isLoading ? (
          <div className="sb-views__loading">
            <Spinner label="Loading views" />
          </div>
        ) : isError ? (
          <EmptyState
            title="Couldn’t load views"
            description="Check the API connection and try again."
          />
        ) : views.length === 0 ? (
          <EmptyState
            title="No saved views"
            description="Create a Smart View to save a reusable lead segment."
          />
        ) : (
          <ul
            className="sb-views__list"
            role="listbox"
            aria-label="Saved views"
            {...nav.containerProps}
          >
            {views.map((view, index) => {
              const itemProps = nav.getItemProps(index);
              return (
                <li
                  key={view.id}
                  aria-label={view.name}
                  className={cx('sb-views__opt', itemProps['aria-selected'] && 'is-active')}
                  {...itemProps}
                >
                  <span className="sb-views__opt-main">
                    <span className="sb-views__opt-name">{view.name}</span>
                    <span className="sb-views__opt-meta">{view.dsl}</span>
                  </span>
                  <StatusPill tone={view.shared ? 'inSequence' : 'neutral'}>
                    {view.shared ? 'Shared' : 'Private'}
                  </StatusPill>
                  <Link
                    className="sb-btn sb-btn--ghost"
                    to={`/views/${view.id}/edit`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    Edit
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Page>
  );
}
