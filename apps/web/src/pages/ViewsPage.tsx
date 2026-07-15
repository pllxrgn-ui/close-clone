import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { cx } from '../lib/cx.ts';
import { listLeads } from '../api/leads.ts';
import { useListNav, KbdCombo } from '../keyboard/index.ts';
import { EmptyState, Spinner, StatusPill } from '../ui/index.ts';
import { Page, PlaceholderNote } from './Page.tsx';

/**
 * Views placeholder. The Smart View builder lands later; the "Recent leads"
 * panel here is a live demonstration of the reusable useListNav hook (roving
 * tabindex, j/k to move, Enter to open) wired to the API client.
 */
export function ViewsPage(): JSX.Element {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['views-demo-leads'],
    queryFn: () => listLeads({ limit: 12 }),
  });
  const leads = data?.items ?? [];

  const nav = useListNav({
    count: leads.length,
    onActivate: (index) => {
      const lead = leads[index];
      if (lead) navigate(`/leads/${lead.id}`);
    },
  });

  return (
    <Page title="Views" subtitle="Saved Smart Views built on the query DSL.">
      <PlaceholderNote>
        The Smart View builder and DSL editor land in a later phase. This list demonstrates the
        reusable j/k keyboard navigation used across every list surface.
      </PlaceholderNote>

      <section className="sb-demo" aria-label="Keyboard navigation demo">
        <header className="sb-demo__head">
          <h2 className="sb-demo__title">Recent leads</h2>
          <span className="sb-demo__hint" aria-hidden="true">
            <KbdCombo combo="j" />
            <KbdCombo combo="k" />
            <span>move</span>
            <KbdCombo combo="enter" />
            <span>open</span>
          </span>
        </header>

        {isLoading ? (
          <div className="sb-demo__loading">
            <Spinner label="Loading leads" />
          </div>
        ) : isError ? (
          <EmptyState title="Couldn’t load leads" description="The mock API request failed." />
        ) : leads.length === 0 ? (
          <EmptyState title="No leads yet" description="Leads will appear here." />
        ) : (
          <ul
            className="sb-demo__list"
            role="listbox"
            aria-label="Recent leads"
            {...nav.containerProps}
          >
            {leads.map((lead, index) => {
              const itemProps = nav.getItemProps(index);
              return (
                <li
                  key={lead.id}
                  aria-label={lead.name}
                  className={cx('sb-demo__opt', itemProps['aria-selected'] && 'is-active')}
                  {...itemProps}
                >
                  <span className="sb-demo__opt-main">
                    <span className="sb-demo__opt-name">{lead.name}</span>
                    {lead.description ? (
                      <span className="sb-demo__opt-meta">{lead.description}</span>
                    ) : null}
                  </span>
                  {lead.dnc ? (
                    <StatusPill tone="dnc" dot>
                      DNC
                    </StatusPill>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Page>
  );
}
