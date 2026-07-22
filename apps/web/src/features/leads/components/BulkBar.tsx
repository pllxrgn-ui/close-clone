import type { JSX } from 'react';
import { Suspense, lazy } from 'react';
import { IconButton, Spinner } from '../../../ui/index.ts';
import { XIcon } from '../icons.tsx';
import type { Lead } from '@switchboard/shared';

// Lazy: the admin feature must not ride in the leads chunk (audit #6) — the
// bar only exists after a selection, so the fetch cost hides behind the click.
const LeadBulkActions = lazy(() =>
  import('../../admin/bulk/LeadBulkActions.tsx').then((m) => ({ default: m.LeadBulkActions })),
);

/*
 * Bulk-action bar shown when one or more leads are selected. The live actions
 * (assign, status, enroll, DNC, export) come from the admin feature's
 * LeadBulkActions; each mutates through the C7 layer. "Clear selection" is local.
 */

interface BulkBarProps {
  count: number;
  selectedLeads: readonly Lead[];
  onClear: () => void;
}

export function BulkBar({ count, onClear, selectedLeads }: BulkBarProps): JSX.Element | null {
  if (count <= 0) return null;
  return (
    <div className="bulk-bar" role="region" aria-label={`${count} leads selected`}>
      <span className="bulk-bar__count" aria-live="polite">
        <strong>{count.toLocaleString('en-US')}</strong> selected
      </span>
      <div className="bulk-bar__actions">
        <Suspense fallback={<Spinner label="Loading actions" />}>
          <LeadBulkActions selectedLeads={selectedLeads} onDone={onClear} />
        </Suspense>
      </div>
      <IconButton label="Clear selection" onClick={onClear} className="bulk-bar__clear">
        <XIcon size={16} />
      </IconButton>
    </div>
  );
}
