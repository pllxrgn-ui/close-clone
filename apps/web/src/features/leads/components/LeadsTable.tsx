import { useEffect, useId, useRef } from 'react';
import type { CSSProperties, JSX } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Lead } from '@switchboard/shared';
import { cx } from '../../../lib/cx.ts';
import { useKeyBindings, useListNav } from '../../../keyboard/index.ts';
import type { KeyBindingDef } from '../../../keyboard/index.ts';
import { Spinner } from '../../../ui/index.ts';
import { ChevronDownIcon, ChevronUpIcon } from '../icons.tsx';
import type { ColumnCtx, ColumnDef } from '../columns/columns.tsx';
import { primaryLeadState } from '../lib/leadState.ts';
import { Rail } from './Rail.tsx';
import { LeadStatePills } from './LeadStatePills.tsx';

/** Dense row height (LAW: 36px dense) — also the virtualizer's size estimate. */
export const LEAD_ROW_H = 36;

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

interface LeadsTableProps {
  leads: Lead[];
  columns: ColumnDef[];
  ctx: ColumnCtx;
  sort: SortState | null;
  onSortChange: (key: string) => void;
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  /** 'all' | 'some' | 'none' — drives the header checkbox + indeterminate. */
  selectAllState: 'all' | 'some' | 'none';
  onOpen: (lead: Lead) => void;
  now: Date;
  totalCount?: number;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  reducedMotion?: boolean;
  /** Test seam: fixed row height for the virtualizer (defaults to LEAD_ROW_H). */
  estimateRowHeight?: number;
}

const PREFETCH_ROWS = 8;

export function LeadsTable({
  leads,
  columns,
  ctx,
  sort,
  onSortChange,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  selectAllState,
  onOpen,
  now,
  totalCount,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  reducedMotion = false,
  estimateRowHeight,
}: LeadsTableProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const baseId = useId();

  const rowH = estimateRowHeight ?? LEAD_ROW_H;
  const virtualizer = useVirtualizer({
    count: leads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 12,
  });

  const nav = useListNav({
    count: leads.length,
    group: 'Leads',
    onActivate: (index) => {
      const lead = leads[index];
      if (lead) onOpen(lead);
    },
  });

  // Keep the keyboard-active row scrolled into view. Keyboard-initiated → never
  // animated (instant), honoring the LAW; overscan(12) keeps the target mounted
  // so useListNav's focus lands even at the window edge.
  const activeIndex = nav.activeIndex;
  useEffect(() => {
    if (activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
  }, [activeIndex, virtualizer]);

  // Extra list-scope shortcuts beyond useListNav's j/k/enter: o opens, x selects.
  const extraKeys: KeyBindingDef[] = [
    {
      id: `${baseId}-open`,
      combo: 'o',
      scope: 'list',
      label: 'Open lead',
      group: 'Leads',
      when: () => nav.focusWithin,
      handler: () => {
        const lead = leads[nav.activeIndex];
        if (lead) onOpen(lead);
      },
    },
    {
      id: `${baseId}-select`,
      combo: 'x',
      scope: 'list',
      label: 'Select lead',
      group: 'Leads',
      when: () => nav.focusWithin,
      handler: () => {
        const lead = leads[nav.activeIndex];
        if (lead) onToggleSelect(lead.id);
      },
    },
  ];
  useKeyBindings(extraKeys);

  // Header select-all: reflect the tri-state via the native indeterminate flag.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectAllState === 'some';
  }, [selectAllState]);

  // Keyset "load more": prefetch as the window approaches the tail.
  const virtualRows = virtualizer.getVirtualItems();
  const lastIndex = virtualRows.length > 0 ? virtualRows[virtualRows.length - 1]!.index : -1;
  useEffect(() => {
    if (hasMore && !loadingMore && onLoadMore && lastIndex >= leads.length - 1 - PREFETCH_ROWS) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore, lastIndex, leads.length]);

  // The 4px state rail is a decorative overlay (not a grid cell), so every row's
  // children are proper cells and aria-colcount is exact.
  const template = `var(--lead-select-w) ${columns.map((c) => c.width).join(' ')} var(--lead-state-w)`;
  const gridStyle = { '--lead-cols': template } as CSSProperties;

  return (
    <div
      className="lead-table"
      data-reduced-motion={reducedMotion ? 'true' : undefined}
      style={gridStyle}
    >
      <div
        className="lead-table__grid"
        role="grid"
        aria-label="Leads"
        aria-multiselectable="true"
        aria-colcount={columns.length + 2}
        {...(totalCount !== undefined ? { 'aria-rowcount': totalCount + 1 } : {})}
      >
        {/* Header row (sort controls + select-all) */}
        <div className="lead-table__head" role="rowgroup">
        <div className="lead-table__row lead-table__row--head" role="row" aria-rowindex={1}>
          <span className="lead-cell lead-cell--select" role="columnheader">
            <input
              ref={selectAllRef}
              type="checkbox"
              className="lead-check"
              aria-label="Select all loaded leads"
              checked={selectAllState === 'all'}
              onChange={onToggleSelectAll}
            />
          </span>
          {columns.map((col) => {
            const active = sort?.key === col.key;
            const ariaSort = active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none';
            return (
              <span
                key={col.key}
                className={cx('lead-cell', 'lead-cell--head', `lead-cell--${col.align}`)}
                role="columnheader"
                aria-sort={col.sortable ? ariaSort : undefined}
              >
                {col.sortable ? (
                  <button
                    type="button"
                    className={cx('lead-sort', active && 'is-active')}
                    onClick={() => onSortChange(col.key)}
                  >
                    <span className="lead-sort__label">{col.header}</span>
                    {active ? (
                      sort?.dir === 'asc' ? (
                        <ChevronUpIcon size={13} className="lead-sort__icon" />
                      ) : (
                        <ChevronDownIcon size={13} className="lead-sort__icon" />
                      )
                    ) : null}
                  </button>
                ) : (
                  <span className="lead-sort__label">{col.header}</span>
                )}
              </span>
            );
          })}
          <span className="lead-cell lead-cell--state" role="columnheader">
            <span className="lead-sort__label">State</span>
          </span>
        </div>
      </div>

        {/* Virtualized body */}
        <div
          ref={scrollRef}
          className="lead-table__body"
          data-virtual-scroll="true"
          role="rowgroup"
          {...nav.containerProps}
        >
          <div
            className="lead-table__viewport"
            role="presentation"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
          {virtualRows.map((vi) => {
            const lead = leads[vi.index];
            if (!lead) return null;
            const itemProps = nav.getItemProps(vi.index);
            const selected = selectedIds.has(lead.id);
            const primary = primaryLeadState(lead, now);
            const rowStyle: CSSProperties = {
              transform: `translateY(${vi.start}px)`,
              height: `${vi.size}px`,
            };
            return (
              <div
                key={lead.id}
                ref={itemProps.ref}
                role="row"
                aria-rowindex={vi.index + 2}
                aria-selected={selected}
                aria-label={rowLabel(lead, ctx, primary)}
                tabIndex={itemProps.tabIndex}
                className={cx('lead-table__row', 'lead-row', selected && 'is-selected')}
                data-active={vi.index === nav.activeIndex ? 'true' : undefined}
                style={rowStyle}
                onClick={itemProps.onClick}
                onFocus={itemProps.onFocus}
              >
                <Rail state={primary} className="lead-row__rail" />
                <span className="lead-cell lead-cell--select" role="gridcell">
                  <input
                    type="checkbox"
                    className="lead-check"
                    aria-label={`Select ${lead.name}`}
                    checked={selected}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onToggleSelect(lead.id)}
                  />
                </span>
                {columns.map((col) => (
                  <span
                    key={col.key}
                    className={cx('lead-cell', `lead-cell--${col.align}`)}
                    role="gridcell"
                  >
                    {col.render(lead, ctx)}
                  </span>
                ))}
                <span className="lead-cell lead-cell--state" role="gridcell">
                  <LeadStatePills
                    lead={lead}
                    now={now}
                    className="lead-statepills"
                  />
                </span>
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {loadingMore ? (
        <div className="lead-table__more">
          <Spinner label="Loading more leads" />
          <span className="lead-table__more-text">Loading more…</span>
        </div>
      ) : hasMore && onLoadMore ? (
        <div className="lead-table__more">
          <button type="button" className="sb-btn sb-btn--sm" onClick={onLoadMore}>
            Load more
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A concise, screen-reader-friendly summary for a grid row. */
function rowLabel(lead: Lead, ctx: ColumnCtx, primary: string | null): string {
  const parts = [lead.name, ctx.statusLabel(lead.statusId)];
  const owner = ctx.ownerName(lead.ownerId);
  if (owner !== '—') parts.push(`owner ${owner}`);
  if (primary) parts.push(primary);
  return parts.filter((p) => p && p !== '—').join(', ');
}
