import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/errors.ts';
import {
  fetchCompleteActivityReport,
  fetchCompleteFunnelReport,
  fetchCompleteSequencesReport,
} from '../reports/api/reports.ts';
import { StatTile } from '../reports/components/charts.tsx';
import { ReportError, TilesSkeleton } from '../reports/components/states.tsx';
import {
  formatInt,
  formatMoneyCents,
  formatPercent,
  formatTalkTime,
  replyRatePercent,
} from '../reports/lib/format.ts';
import { rangeForKey, reportNow } from '../reports/lib/range.ts';
import { sumActivityRows } from '../reports/lib/totals.ts';
import type { FunnelStageRow } from '../reports/types.ts';
import '../reports/reports.css';

function pipelineByCurrency(rows: FunnelStageRow[]): Array<[string, number, number]> {
  const totals = new Map<string, [number, number]>();
  for (const row of rows) {
    const current = totals.get(row.currency) ?? [0, 0];
    totals.set(row.currency, [current[0] + row.openCount, current[1] + row.openValueCents]);
  }
  return [...totals].map(([currency, [count, cents]]) => [currency, count, cents]);
}

export function OverviewPage(): JSX.Element {
  const range = rangeForKey('30d', reportNow());
  const activity = useQuery({
    queryKey: ['overview', 'activity', range.from, range.to],
    queryFn: ({ signal }) => fetchCompleteActivityReport(range, signal),
  });
  const funnel = useQuery({
    queryKey: ['overview', 'funnel'],
    queryFn: ({ signal }) => fetchCompleteFunnelReport({}, signal),
  });
  const sequences = useQuery({
    queryKey: ['overview', 'sequences'],
    queryFn: ({ signal }) => fetchCompleteSequencesReport({}, signal),
  });

  const queries = [activity, funnel, sequences];
  const failed = queries.find((query) => query.isError);
  if (failed) {
    const message = failed.error instanceof ApiError ? failed.error.message : 'unexpected error';
    return (
      <div className="rpt">
        <header className="rpt__head">
          <h1 className="rpt__title">Overview</h1>
        </header>
        <ReportError
          message={message}
          onRetry={() => void Promise.all(queries.map((q) => q.refetch()))}
        />
      </div>
    );
  }

  if (queries.some((query) => query.isLoading)) {
    return (
      <div className="rpt">
        <header className="rpt__head">
          <h1 className="rpt__title">Overview</h1>
        </header>
        <TilesSkeleton />
      </div>
    );
  }

  const activityTotals = sumActivityRows(activity.data?.items ?? []);
  const pipeline = pipelineByCurrency(funnel.data?.items ?? []);
  const sequenceRows = sequences.data?.items ?? [];
  const sequenceTotals = sequenceRows.reduce(
    (sum, row) => ({ sends: sum.sends + row.sends, replies: sum.replies + row.replies }),
    { sends: 0, replies: 0 },
  );

  return (
    <div className="rpt">
      <header className="rpt__head">
        <div>
          <h1 className="rpt__title">Overview</h1>
          <p className="rpt__sub">Live operating picture. Activity is the last 30 UTC days.</p>
        </div>
      </header>

      <div className="rpt-panel">
        <div className="rpt-tiles" aria-label="Thirty-day activity totals">
          <StatTile label="Calls logged" value={formatInt(activityTotals.callsLogged)} />
          <StatTile label="Emails sent" value={formatInt(activityTotals.emailsSent)} />
          <StatTile label="Talk time" value={formatTalkTime(activityTotals.talkTimeSeconds)} />
          <StatTile
            label="Sequence reply rate"
            value={formatPercent(replyRatePercent(sequenceTotals.sends, sequenceTotals.replies))}
          />
        </div>

        <div className="rpt-grid">
          <section className="rpt-card" aria-labelledby="overview-pipeline">
            <span id="overview-pipeline" className="rpt-card__label">
              Live pipeline
            </span>
            {pipeline.length === 0 ? (
              <p className="rpt__sub">No open opportunities yet.</p>
            ) : (
              <div className="rpt-table-wrap">
                <table className="rpt-table">
                  <thead>
                    <tr>
                      <th scope="col">Currency</th>
                      <th scope="col" className="is-num">
                        Open
                      </th>
                      <th scope="col" className="is-num">
                        Value
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pipeline.map(([currency, count, cents]) => (
                      <tr key={currency}>
                        <td>{currency}</td>
                        <td className="is-num">{formatInt(count)}</td>
                        <td className="is-num">{formatMoneyCents(cents, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rpt-card" aria-labelledby="overview-next">
            <span id="overview-next" className="rpt-card__label">
              Next actions
            </span>
            <p className="rpt__sub">
              Work the queue, inspect pipeline, or audit the underlying numbers.
            </p>
            <div className="rpt-toolbar">
              <Link className="sb-btn sb-btn--primary" to="/inbox">
                Open inbox
              </Link>
              <Link className="sb-btn sb-btn--ghost" to="/reports">
                View reports
              </Link>
              <Link className="sb-btn sb-btn--ghost" to="/pipeline">
                Open pipeline
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
