import type { JSX, ReactNode } from 'react';
import type { Lead } from '@switchboard/shared';
import { StatusPill } from '../../../ui/index.ts';
import type { StatusTone } from '../../../ui/index.ts';
import { initials } from '../../../lib/format.ts';
import { formatDate, formatRelativeTime } from '../lib/format.ts';

/*
 * Column registry for the dense leads table. A Smart View's `columns` are DSL
 * field names (CONTRACTS §C3 builtins); this maps each to a header, a grid track
 * width, an accessible client-side sort accessor, and a dense cell renderer.
 * Unknown fields degrade to a labelled em-dash column rather than throwing, so a
 * view referencing a not-yet-supported field still renders.
 */

export interface ColumnCtx {
  statusLabel: (id: string | null) => string;
  ownerName: (id: string | null) => string;
  now: Date;
}

export type SortValue = string | number | null;

export interface ColumnDef {
  /** DSL field key (e.g. `last_contacted`). */
  key: string;
  header: string;
  /** CSS grid track for this column. */
  width: string;
  align: 'left' | 'right';
  sortable: boolean;
  /** Value used for client-side sorting; null sorts last regardless of dir. */
  sortValue?: (lead: Lead, ctx: ColumnCtx) => SortValue;
  render: (lead: Lead, ctx: ColumnCtx) => ReactNode;
}

function statusTone(label: string): StatusTone {
  if (label === 'Won') return 'won';
  if (label === 'Lost') return 'lost';
  return 'neutral';
}

function OwnerCell({ name }: { name: string }): JSX.Element {
  if (name === '—') return <span className="lead-cell__muted">—</span>;
  return (
    <span className="lead-owner" title={name}>
      <span className="lead-owner__avatar" aria-hidden="true">
        {initials(name)}
      </span>
      <span className="lead-owner__name">{name}</span>
    </span>
  );
}

function timeMs(iso: string | null): number | null {
  if (iso === null) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function RelCell({ iso, now }: { iso: string | null; now: Date }): JSX.Element {
  if (iso === null) return <span className="lead-cell__muted">—</span>;
  return (
    <time dateTime={iso} className="lead-cell__time">
      {formatRelativeTime(iso, now)}
    </time>
  );
}

const nameColumn: ColumnDef = {
  key: 'name',
  header: 'Name',
  width: 'minmax(200px, 2.2fr)',
  align: 'left',
  sortable: true,
  sortValue: (lead) => lead.name.toLowerCase(),
  render: (lead) => <span className="lead-cell__name">{lead.name}</span>,
};

const statusColumn: ColumnDef = {
  key: 'status',
  header: 'Status',
  width: 'minmax(96px, 0.8fr)',
  align: 'left',
  sortable: true,
  sortValue: (lead, ctx) => ctx.statusLabel(lead.statusId).toLowerCase(),
  render: (lead, ctx) => {
    const label = ctx.statusLabel(lead.statusId);
    if (label === '—') return <span className="lead-cell__muted">—</span>;
    return <StatusPill tone={statusTone(label)}>{label}</StatusPill>;
  },
};

const ownerColumn: ColumnDef = {
  key: 'owner',
  header: 'Owner',
  width: 'minmax(120px, 1fr)',
  align: 'left',
  sortable: true,
  sortValue: (lead, ctx) => ctx.ownerName(lead.ownerId).toLowerCase(),
  render: (lead, ctx) => <OwnerCell name={ctx.ownerName(lead.ownerId)} />,
};

function relColumn(
  key: string,
  header: string,
  field: 'lastContactedAt' | 'lastInboundAt' | 'lastCallAt' | 'lastEmailAt' | 'lastSmsAt',
): ColumnDef {
  return {
    key,
    header,
    width: 'minmax(104px, 0.7fr)',
    align: 'right',
    sortable: true,
    sortValue: (lead) => timeMs(lead[field]),
    render: (lead, ctx) => <RelCell iso={lead[field]} now={ctx.now} />,
  };
}

const nextTaskColumn: ColumnDef = {
  key: 'next_task_due',
  header: 'Next task',
  width: 'minmax(104px, 0.7fr)',
  align: 'right',
  sortable: true,
  sortValue: (lead) => timeMs(lead.nextTaskDueAt),
  render: (lead, ctx) => {
    const iso = lead.nextTaskDueAt;
    if (iso === null) return <span className="lead-cell__muted">—</span>;
    const overdue = (timeMs(iso) ?? Infinity) < ctx.now.getTime();
    return (
      <time dateTime={iso} className={overdue ? 'lead-cell__time is-overdue' : 'lead-cell__time'}>
        {formatRelativeTime(iso, ctx.now)}
      </time>
    );
  },
};

const createdColumn: ColumnDef = {
  key: 'created',
  header: 'Created',
  width: 'minmax(104px, 0.7fr)',
  align: 'right',
  sortable: true,
  sortValue: (lead) => timeMs(lead.createdAt),
  render: (lead) => (
    <time dateTime={lead.createdAt} className="lead-cell__time">
      {formatDate(lead.createdAt)}
    </time>
  ),
};

const updatedColumn: ColumnDef = {
  key: 'updated',
  header: 'Updated',
  width: 'minmax(104px, 0.7fr)',
  align: 'right',
  sortable: true,
  sortValue: (lead) => timeMs(lead.updatedAt),
  render: (lead, ctx) => <RelCell iso={lead.updatedAt} now={ctx.now} />,
};

const dncColumn: ColumnDef = {
  key: 'dnc',
  header: 'DNC',
  width: '64px',
  align: 'left',
  sortable: true,
  sortValue: (lead) => (lead.dnc ? 1 : 0),
  render: (lead) =>
    lead.dnc ? (
      <StatusPill tone="dnc" dot>
        DNC
      </StatusPill>
    ) : (
      <span className="lead-cell__muted">—</span>
    ),
};

/** Registry keyed by DSL field name. */
export const COLUMN_DEFS: Record<string, ColumnDef> = {
  name: nameColumn,
  status: statusColumn,
  owner: ownerColumn,
  last_contacted: relColumn('last_contacted', 'Last contact', 'lastContactedAt'),
  last_inbound: relColumn('last_inbound', 'Last reply', 'lastInboundAt'),
  next_task_due: nextTaskColumn,
  created: createdColumn,
  updated: updatedColumn,
  dnc: dncColumn,
};

/** Columns used when a view specifies none (the "All leads" surface). */
export const DEFAULT_COLUMN_KEYS: readonly string[] = [
  'name',
  'status',
  'owner',
  'last_inbound',
  'last_contacted',
  'next_task_due',
];

function humanizeField(key: string): string {
  return key
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** A non-throwing column for a field the table doesn't render specially. */
function fallbackColumn(key: string): ColumnDef {
  return {
    key,
    header: humanizeField(key),
    width: 'minmax(96px, 0.7fr)',
    align: 'left',
    sortable: false,
    render: () => <span className="lead-cell__muted">—</span>,
  };
}

/**
 * Resolve a view's `columns` (unknown JSON array of DSL field names) to concrete
 * ColumnDefs, always leading with `name` and falling back to the default set.
 */
export function resolveColumns(columns: unknown): ColumnDef[] {
  const keys =
    Array.isArray(columns) && columns.length > 0
      ? columns.filter((c): c is string => typeof c === 'string')
      : [...DEFAULT_COLUMN_KEYS];
  const ordered = keys.includes('name') ? keys : ['name', ...keys];
  const seen = new Set<string>();
  const defs: ColumnDef[] = [];
  for (const key of ordered) {
    if (seen.has(key)) continue;
    seen.add(key);
    defs.push(COLUMN_DEFS[key] ?? fallbackColumn(key));
  }
  return defs;
}

/** Stable comparator for a column + direction, pushing nulls to the end. */
export function compareByColumn(
  col: ColumnDef,
  dir: 'asc' | 'desc',
  ctx: ColumnCtx,
): (a: Lead, b: Lead) => number {
  const factor = dir === 'asc' ? 1 : -1;
  const accessor = col.sortValue;
  return (a, b) => {
    if (!accessor) return 0;
    const av = accessor(a, ctx);
    const bv = accessor(b, ctx);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulls last, regardless of direction
    if (bv === null) return -1;
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return 0;
  };
}
