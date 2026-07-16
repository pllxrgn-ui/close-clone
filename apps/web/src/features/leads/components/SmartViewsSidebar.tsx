import { Fragment, useMemo } from 'react';
import type { JSX } from 'react';
import type { SmartView } from '@switchboard/shared';
import { cx } from '../../../lib/cx.ts';
import { useListNav } from '../../../keyboard/index.ts';
import { Skeleton, Button } from '../../../ui/index.ts';
import { FilterIcon, InboxIcon, UsersIcon } from '../icons.tsx';

/*
 * The Smart Views rail: a keyboardable (j/k/enter, roving tabindex) list of saved
 * views plus the always-present "All leads" entry. Presentational — the surface
 * owns the GET /smart-views query and passes state down, so loading/error/empty
 * are rendered here from typed flags. Selecting a view is single-select: the
 * active route's entry carries aria-current + aria-selected.
 */

interface Entry {
  id: string | null;
  name: string;
  group: 'pinned' | 'shared' | 'mine';
  shared: boolean;
}

interface SmartViewsSidebarProps {
  views: SmartView[];
  activeViewId: string | null;
  onSelect: (id: string | null) => void;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
}

const GROUP_LABEL: Record<Entry['group'], string> = {
  pinned: 'Views',
  shared: 'Shared',
  mine: 'My views',
};

export function SmartViewsSidebar({
  views,
  activeViewId,
  onSelect,
  isLoading,
  isError,
  errorMessage,
  onRetry,
}: SmartViewsSidebarProps): JSX.Element {
  const entries = useMemo<Entry[]>(() => {
    const all: Entry = { id: null, name: 'All leads', group: 'pinned', shared: false };
    const shared = views
      .filter((v) => v.shared)
      .map<Entry>((v) => ({ id: v.id, name: v.name, group: 'shared', shared: true }));
    const mine = views
      .filter((v) => !v.shared)
      .map<Entry>((v) => ({ id: v.id, name: v.name, group: 'mine', shared: false }));
    return [all, ...shared, ...mine];
  }, [views]);

  const activeIndex = Math.max(
    0,
    entries.findIndex((e) => e.id === activeViewId),
  );

  const nav = useListNav({
    count: entries.length,
    initialIndex: activeIndex,
    group: 'Smart Views',
    onActivate: (index) => {
      const entry = entries[index];
      if (entry) onSelect(entry.id);
    },
  });

  return (
    <nav className="sv-rail" aria-label="Smart Views">
      <div className="sv-rail__head">
        <FilterIcon size={14} className="sv-rail__head-icon" />
        <span className="sv-rail__head-label">Views</span>
      </div>

      {isLoading ? (
        <div className="sv-rail__loading" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={28} className="sv-rail__skel" />
          ))}
        </div>
      ) : (
        <div
          className="sv-rail__list"
          role="listbox"
          aria-label="Smart Views"
          {...nav.containerProps}
        >
          {entries.map((entry, index) => {
            const prev = entries[index - 1];
            const showHeader = !prev || prev.group !== entry.group;
            const itemProps = nav.getItemProps(index);
            const current = entry.id === activeViewId;
            return (
              <Fragment key={entry.id ?? '__all__'}>
                {showHeader ? (
                  <div className="sv-rail__group" aria-hidden="true">
                    {GROUP_LABEL[entry.group]}
                  </div>
                ) : null}
                <div
                  ref={itemProps.ref}
                  role="option"
                  tabIndex={itemProps.tabIndex}
                  aria-selected={current}
                  {...(current ? { 'aria-current': 'page' as const } : {})}
                  className={cx('sv-rail__item', current && 'is-current')}
                  onClick={itemProps.onClick}
                  onFocus={itemProps.onFocus}
                >
                  <span className="sv-rail__item-icon" aria-hidden="true">
                    {entry.id === null ? <InboxIcon size={14} /> : <FilterIcon size={14} />}
                  </span>
                  <span className="sv-rail__item-name">{entry.name}</span>
                  {entry.shared ? (
                    <UsersIcon size={12} className="sv-rail__item-shared" title="Shared view" />
                  ) : null}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}

      {isError ? (
        <div className="sv-rail__error" role="alert">
          <span>{errorMessage ?? 'Couldn’t load views.'}</span>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
