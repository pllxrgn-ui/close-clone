/*
 * Funnel / pipeline report — grouped by currency (values never sum across
 * currencies, CONTRACTS §C1). Each currency shows a proportional horizontal
 * funnel band (achromatic fills; won in --state-reply, lost in --state-dnc) over
 * a stage table: open count, open value, weighted value (display numerals), and
 * the won/lost tallies. Open metrics are the live snapshot.
 */
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState } from '../../../ui/index.ts';
import { ApiError } from '../../../api/errors.ts';
import { fetchCompleteFunnelReport } from '../api/reports.ts';
import { formatInt, formatMoneyCents } from '../lib/format.ts';
import { stageKind } from '../lib/stages.ts';
import type { FunnelStageRow } from '../types.ts';
import { FunnelBand } from './charts.tsx';
import type { FunnelSegment } from './charts.tsx';
import { ReportError, RowsSkeleton } from './states.tsx';

/** Group pre-sorted rows into per-currency blocks, preserving order. */
function groupByCurrency(rows: readonly FunnelStageRow[]): Array<[string, FunnelStageRow[]]> {
  const groups = new Map<string, FunnelStageRow[]>();
  for (const row of rows) {
    const list = groups.get(row.currency);
    if (list) list.push(row);
    else groups.set(row.currency, [row]);
  }
  return [...groups.entries()];
}

function FunnelGroup({
  currency,
  rows,
}: {
  currency: string;
  rows: FunnelStageRow[];
}): JSX.Element {
  const segments: FunnelSegment[] = rows.map((r) => {
    const count = r.openCount + r.wonCount + r.lostCount;
    return {
      id: r.stageId,
      label: r.stageLabel,
      count,
      display: formatInt(count),
      kind: stageKind(r.stageLabel),
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      open: acc.open + r.openCount,
      value: acc.value + r.openValueCents,
      weighted: acc.weighted + r.openWeightedValueCents,
      won: acc.won + r.wonCount,
      lost: acc.lost + r.lostCount,
    }),
    { open: 0, value: 0, weighted: 0, won: 0, lost: 0 },
  );

  return (
    <section className="rpt-card" aria-label={`${currency} pipeline`}>
      <span className="rpt-card__label">{currency} pipeline</span>
      <FunnelBand segments={segments} />
      <div className="rpt-table-wrap">
        <table className="rpt-table">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col" className="is-num">
                Open
              </th>
              <th scope="col" className="is-num">
                Value
              </th>
              <th scope="col" className="is-num">
                Weighted
              </th>
              <th scope="col" className="is-num">
                Won
              </th>
              <th scope="col" className="is-num">
                Lost
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.stageId}>
                <td className="rpt-table__name">{r.stageLabel}</td>
                <td className="is-num">{formatInt(r.openCount)}</td>
                <td className="is-num">{formatMoneyCents(r.openValueCents, currency)}</td>
                <td className="is-display">
                  {formatMoneyCents(r.openWeightedValueCents, currency)}
                </td>
                <td className={r.wonCount > 0 ? 'is-num' : 'is-num is-dim'}>
                  {formatInt(r.wonCount)}
                </td>
                <td className={r.lostCount > 0 ? 'is-num' : 'is-num is-dim'}>
                  {formatInt(r.lostCount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="is-num">{formatInt(totals.open)}</td>
              <td className="is-num">{formatMoneyCents(totals.value, currency)}</td>
              <td className="is-display">{formatMoneyCents(totals.weighted, currency)}</td>
              <td className="is-num">{formatInt(totals.won)}</td>
              <td className="is-num">{formatInt(totals.lost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

export function FunnelReport(): JSX.Element {
  const q = useQuery({
    queryKey: ['reports', 'funnel'],
    queryFn: ({ signal }) => fetchCompleteFunnelReport({}, signal),
  });

  if (q.isLoading) {
    return (
      <div className="rpt-panel">
        <div className="rpt-card">
          <span className="rpt-card__label">Pipeline</span>
          <RowsSkeleton count={6} />
        </div>
      </div>
    );
  }

  if (q.isError) {
    const message = q.error instanceof ApiError ? q.error.message : 'unexpected error';
    return (
      <div className="rpt-panel">
        <ReportError
          message={message}
          onRetry={() => {
            void q.refetch();
          }}
        />
      </div>
    );
  }

  const rows = q.data?.items ?? [];
  if (rows.length === 0) {
    return (
      <div className="rpt-panel">
        <EmptyState title="No pipeline yet" description="No opportunities have a stage to chart." />
      </div>
    );
  }

  const groups = groupByCurrency(rows);
  return (
    <div className="rpt-panel">
      <div className="rpt-live rpt-funnelgroup" data-busy={q.isFetching && !q.isLoading}>
        {groups.map(([currency, groupRows]) => (
          <FunnelGroup key={currency} currency={currency} rows={groupRows} />
        ))}
      </div>
    </div>
  );
}
