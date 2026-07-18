import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../../ui/index.ts';
import { countNoun } from '../../lib/format.ts';
import { ArrowRightIcon, DoneIcon, ResetIcon } from '../../icons.tsx';
import type { CommitResponse } from '../../types.ts';

/*
 * Step 04 — the commit summary. The write has happened (leads + contacts are on
 * the board and each new lead has its timeline); the primary path is straight to
 * the leads board to see them. Re-commit is guarded server-side, so this screen
 * is terminal — "Import another file" starts a fresh run.
 */
export interface CommitStepProps {
  commit: CommitResponse;
  filename: string;
  onReset: () => void;
}

export function CommitStep({ commit, filename, onReset }: CommitStepProps): JSX.Element {
  const navigate = useNavigate();
  const { leads, contacts, merged } = commit.counters;

  return (
    <div className="imp-panel imp-done">
      <DoneIcon size={40} className="imp-done__icon" />
      <h2 className="imp-done__title">Import complete</h2>
      <p className="imp-done__sub">
        <span className="imp-done__file">{filename}</span> is in.
      </p>

      <div className="imp-done__counts">
        <span className="imp-done__count">
          <b>{leads.toLocaleString()}</b> {leads === 1 ? 'lead' : 'leads'}
        </span>
        <span className="imp-done__count">
          <b>{contacts.toLocaleString()}</b> {contacts === 1 ? 'contact' : 'contacts'}
        </span>
        {merged > 0 ? (
          <span className="imp-done__count imp-done__count--muted">
            <b>{merged.toLocaleString()}</b> merged
          </span>
        ) : null}
      </div>

      <div className="imp-actions imp-actions--center">
        <Button variant="primary" onClick={() => navigate('/leads')}>
          Go to leads board
          <ArrowRightIcon size={16} />
        </Button>
        <Button variant="ghost" onClick={onReset}>
          <ResetIcon size={16} />
          Import another file
        </Button>
      </div>

      <p className="imp-hint imp-done__hint">
        {countNoun(leads, 'new lead')} added to the board — each with an import entry on its
        timeline.
      </p>
    </div>
  );
}
