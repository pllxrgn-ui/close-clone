/*
 * Sequence performance — per sequence: sends, replies, bounces, unsubscribes,
 * the current active-enrollment count, and a reply-rate meter whose tone bands
 * the rate (≥15 jade · 5–15 amber · <5 dim). Zero-send sequences read an honest
 * 0.0% rather than NaN.
 */
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, StatusPill } from '../../../ui/index.ts';
import { ApiError } from '../../../api/errors.ts';
import { fetchSequencesReport } from '../api/reports.ts';
import { formatInt, formatPercent, meterTone, replyRatePercent } from '../lib/format.ts';
import { MeterBar } from './charts.tsx';
import { ReportError, RowsSkeleton } from './states.tsx';

export function SequencesReport(): JSX.Element {
  const q = useQuery({
    queryKey: ['reports', 'sequences'],
    queryFn: ({ signal }) => fetchSequencesReport({ limit: 500 }, signal),
  });

  if (q.isLoading) {
    return (
      <div className="rpt-panel">
        <div className="rpt-card">
          <span className="rpt-card__label">Sequences</span>
          <RowsSkeleton count={5} />
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
        <EmptyState
          title="No sequences"
          description="No outreach sequences have been created yet."
        />
      </div>
    );
  }

  return (
    <div className="rpt-panel">
      <div className="rpt-live" data-busy={q.isFetching && !q.isLoading}>
        <div className="rpt-card">
          <span className="rpt-card__label">Sequence performance</span>
          <div className="rpt-table-wrap">
            <table className="rpt-table">
              <thead>
                <tr>
                  <th scope="col">Sequence</th>
                  <th scope="col" className="is-num">
                    Sends
                  </th>
                  <th scope="col" className="is-num">
                    Replies
                  </th>
                  <th scope="col" className="is-num">
                    Bounces
                  </th>
                  <th scope="col" className="is-num">
                    Unsub
                  </th>
                  <th scope="col" className="is-num">
                    Active
                  </th>
                  <th scope="col">Reply rate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pct = replyRatePercent(r.sends, r.replies);
                  return (
                    <tr key={r.sequenceId}>
                      <td className="rpt-table__name">
                        {r.sequenceName}{' '}
                        <StatusPill tone={r.sequenceStatus === 'active' ? 'inSequence' : 'neutral'}>
                          {r.sequenceStatus}
                        </StatusPill>
                      </td>
                      <td className="is-num">{formatInt(r.sends)}</td>
                      <td className="is-num">{formatInt(r.replies)}</td>
                      <td className="is-num">{formatInt(r.bounces)}</td>
                      <td className="is-num">{formatInt(r.unsubscribes)}</td>
                      <td className="is-num">{formatInt(r.activeEnrollments)}</td>
                      <td>
                        <MeterBar
                          percent={pct}
                          tone={meterTone(pct)}
                          valueText={formatPercent(pct)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
