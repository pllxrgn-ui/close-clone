/*
 * Activity report — org-total stat tiles, a per-rep table (calls in/out, emails
 * sent/received, SMS, talk time in mono H:MM), and a calls-by-rep bar comparison
 * with the leader lit in --state-live. The 7/30/90-day segmented control writes
 * the range to the URL; changing it re-queries MSW (numbers update in place while
 * the previous data stays visible, dimmed).
 */
import { useMemo } from 'react';
import type { JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { EmptyState } from '../../../ui/index.ts';
import { ApiError } from '../../../api/errors.ts';
import { usersQuery } from '../../../api/refQueries.ts';
import { fetchCompleteActivityReport } from '../api/reports.ts';
import {
  DEFAULT_PRESET_KEY,
  RANGE_PRESETS,
  presetByKey,
  rangeForKey,
  reportNow,
} from '../lib/range.ts';
import { formatDateRangeLabel, formatInt, formatTalkTime } from '../lib/format.ts';
import { sumActivityRows } from '../lib/totals.ts';
import { BarComparison, StatTile } from './charts.tsx';
import { ReportError, RowsSkeleton, TilesSkeleton } from './states.tsx';

export function ActivityReport(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const presetKey = presetByKey(params.get('range') ?? DEFAULT_PRESET_KEY).key;
  const range = rangeForKey(presetKey, reportNow());

  const usersQ = useQuery({ ...usersQuery(), staleTime: Number.POSITIVE_INFINITY });
  const q = useQuery({
    queryKey: ['reports', 'activity', range.from, range.to],
    queryFn: ({ signal }) =>
      fetchCompleteActivityReport({ from: range.from, to: range.to }, signal),
    placeholderData: keepPreviousData,
  });

  const nameById = useMemo(
    () => new Map((usersQ.data ?? []).map((u) => [u.id, u.name] as const)),
    [usersQ.data],
  );
  const nameOf = (id: string): string => nameById.get(id) ?? id.slice(0, 8);

  function setPreset(key: string): void {
    setParams(
      (prev) => {
        prev.set('report', 'activity');
        prev.set('range', key);
        return prev;
      },
      { replace: true },
    );
  }

  const toolbar = (
    <div className="rpt-toolbar">
      <div role="group" aria-label="Date range" className="rpt-seg">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className="rpt-seg__btn"
            aria-pressed={p.key === presetKey}
            aria-label={p.aria}
            onClick={() => setPreset(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <span className="rpt-toolbar__caption">
        {formatDateRangeLabel(range.from, range.to)} · UTC
      </span>
    </div>
  );

  if (q.isLoading) {
    return (
      <div className="rpt-panel">
        {toolbar}
        <TilesSkeleton />
        <div className="rpt-grid">
          <div className="rpt-card">
            <span className="rpt-card__label">Activity by rep</span>
            <RowsSkeleton />
          </div>
          <div className="rpt-card">
            <span className="rpt-card__label">Calls by rep</span>
            <RowsSkeleton />
          </div>
        </div>
      </div>
    );
  }

  if (q.isError) {
    const message = q.error instanceof ApiError ? q.error.message : 'unexpected error';
    return (
      <div className="rpt-panel">
        {toolbar}
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
        {toolbar}
        <EmptyState
          title="No activity in this range"
          description={`Nothing was logged ${formatDateRangeLabel(range.from, range.to)}. Try a wider range.`}
        />
      </div>
    );
  }

  const totals = sumActivityRows(rows);
  const bars = [...rows]
    .map((r) => ({
      id: r.bucket,
      label: nameOf(r.bucket),
      value: r.callsLogged,
      display: formatInt(r.callsLogged),
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const tableRows = [...rows].sort((a, b) => nameOf(a.bucket).localeCompare(nameOf(b.bucket)));
  const busy = q.isFetching && !q.isLoading;

  return (
    <div className="rpt-panel">
      {toolbar}
      <div className="rpt-live" data-busy={busy}>
        <div className="rpt-tiles" aria-label="Organization totals">
          <StatTile label="Calls logged" value={formatInt(totals.callsLogged)} />
          <StatTile label="Emails sent" value={formatInt(totals.emailsSent)} />
          <StatTile label="Emails received" value={formatInt(totals.emailsReceived)} />
          <StatTile label="SMS sent" value={formatInt(totals.smsSent)} />
          <StatTile label="Talk time" value={formatTalkTime(totals.talkTimeSeconds)} />
        </div>

        <div className="rpt-grid">
          <div className="rpt-card">
            <span className="rpt-card__label">Activity by rep</span>
            <div className="rpt-table-wrap">
              <table className="rpt-table">
                <thead>
                  <tr>
                    <th scope="col">Rep</th>
                    <th scope="col" className="is-num">
                      Calls in
                    </th>
                    <th scope="col" className="is-num">
                      Calls out
                    </th>
                    <th scope="col" className="is-num">
                      Emails sent
                    </th>
                    <th scope="col" className="is-num">
                      Emails recv
                    </th>
                    <th scope="col" className="is-num">
                      SMS
                    </th>
                    <th scope="col" className="is-num">
                      Talk
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r) => (
                    <tr key={r.bucket}>
                      <td className="rpt-table__name">{nameOf(r.bucket)}</td>
                      <td className="is-num">{formatInt(r.callsInbound)}</td>
                      <td className="is-num">{formatInt(r.callsOutbound)}</td>
                      <td className="is-num">{formatInt(r.emailsSent)}</td>
                      <td className="is-num">{formatInt(r.emailsReceived)}</td>
                      <td className="is-num">{formatInt(r.smsSent)}</td>
                      <td className="is-num">{formatTalkTime(r.talkTimeSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>All reps</td>
                    <td className="is-num">{formatInt(totals.callsInbound)}</td>
                    <td className="is-num">{formatInt(totals.callsOutbound)}</td>
                    <td className="is-num">{formatInt(totals.emailsSent)}</td>
                    <td className="is-num">{formatInt(totals.emailsReceived)}</td>
                    <td className="is-num">{formatInt(totals.smsSent)}</td>
                    <td className="is-num">{formatTalkTime(totals.talkTimeSeconds)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="rpt-card">
            <span className="rpt-card__label">Calls by rep</span>
            <BarComparison items={bars} unitLabel="calls" />
          </div>
        </div>
      </div>
    </div>
  );
}
