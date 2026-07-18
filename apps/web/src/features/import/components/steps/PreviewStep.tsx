import type { JSX, ReactNode } from 'react';
import { Button, EmptyState, StatusPill } from '../../../../ui/index.ts';
import { DispositionPill } from '../DispositionPill.tsx';
import { humanError } from '../../lib/format.ts';
import { ArrowLeftIcon, InfoIcon } from '../../icons.tsx';
import type { DryRunResponse, RowPlan } from '../../types.ts';

/*
 * Step 03 — the dry-run result: a counts board (display numerals, tabular) and
 * the disposition ledger, one row per source row with its decided fate and, for
 * errors, the exact reason. No writes have happened; "Commit import" is the only
 * thing that persists. Rows are capped for very large files.
 */

const MAX_LEDGER_ROWS = 200;

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}): JSX.Element {
  return (
    <div className="imp-stat" data-tone={tone}>
      <span className="imp-stat__value">{value.toLocaleString()}</span>
      <span className="imp-stat__label">{label}</span>
    </div>
  );
}

function rowPrimary(row: RowPlan): ReactNode {
  if (row.outcome === 'empty') return <span className="imp-muted">Blank row — skipped</span>;
  if (row.outcome === 'error') {
    return (
      <ul className="imp-rowerrors">
        {row.errors.map((e, i) => (
          <li key={i}>
            {humanError(e.code)}
            {e.column !== null ? <span className="imp-muted"> · {e.column}</span> : null}
          </li>
        ))}
      </ul>
    );
  }
  const name = row.lead?.name ?? row.contact?.name ?? '—';
  const email = row.contact?.email;
  return (
    <span className="imp-rowwho">
      <span className="imp-rowwho__name">{name}</span>
      {email ? <span className="imp-rowwho__email">{email}</span> : null}
      {row.action === 'merge-fields' ? (
        <span className="imp-muted">merged into existing</span>
      ) : null}
      {row.contact?.suppressed === true ? (
        <StatusPill tone="dnc">Suppressed — flagged, not contacted</StatusPill>
      ) : null}
    </span>
  );
}

export interface PreviewStepProps {
  plan: DryRunResponse;
  onBack: () => void;
  onCommit: () => void;
  isCommitting: boolean;
  commitError: string | null;
}

export function PreviewStep({
  plan,
  onBack,
  onCommit,
  isCommitting,
  commitError,
}: PreviewStepProps): JSX.Element {
  const { counts, rows, warnings } = plan;
  const duplicates = counts.dedupeSkipped + counts.dedupeMerged;
  const canCommit = counts.leadsCreated + counts.contactsCreated + counts.dedupeMerged > 0;
  const shown = rows.slice(0, MAX_LEDGER_ROWS);

  if (counts.totalRows === 0) {
    return (
      <div className="imp-panel">
        <EmptyState
          title="No data rows to import"
          description="This file has a header but no rows beneath it."
          actions={
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeftIcon size={16} />
              Back to mapping
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="imp-panel">
      <div className="imp-stats" role="group" aria-label="Dry-run summary">
        <StatTile label="Total rows" value={counts.totalRows} />
        <StatTile label="Leads to create" value={counts.leadsCreated} tone="create" />
        <StatTile label="Contacts to create" value={counts.contactsCreated} tone="create" />
        <StatTile label="Duplicates" value={duplicates} tone="dedupe" />
        <StatTile label="Error rows" value={counts.errorRows} tone="error" />
        <StatTile label="Empty rows" value={counts.emptyRows} />
      </div>

      {counts.suppressedContacts > 0 ? (
        <p className="imp-note imp-note--dnc" role="note">
          {counts.suppressedContacts} contact
          {counts.suppressedContacts === 1 ? ' is' : 's are'} on the suppression list — imported and
          flagged, never contacted by the engine.
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="imp-warnings" role="note">
          {warnings.map((w) => (
            <li key={w}>
              <InfoIcon size={14} />
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="imp-ledger-scroll">
        <table className="imp-table imp-ledger">
          <thead>
            <tr>
              <th scope="col" className="imp-ledger__idx">
                Row
              </th>
              <th scope="col">Disposition</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.rowIndex} data-outcome={row.outcome}>
                <td className="imp-ledger__idx">{row.rowIndex}</td>
                <td>
                  <DispositionPill outcome={row.outcome} matchType={row.matchType} />
                </td>
                <td>{rowPrimary(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_LEDGER_ROWS ? (
        <p className="imp-hint">
          Showing the first {MAX_LEDGER_ROWS} of {rows.length.toLocaleString()} rows. All rows
          commit.
        </p>
      ) : null}

      {commitError !== null ? (
        <p className="imp-inline-error" role="alert">
          {commitError}
        </p>
      ) : null}

      <div className="imp-actions imp-actions--split">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeftIcon size={16} />
          Adjust mapping
        </Button>
        <Button variant="primary" onClick={onCommit} loading={isCommitting} disabled={!canCommit}>
          {canCommit ? 'Commit import' : 'Nothing to import'}
        </Button>
      </div>
    </div>
  );
}
