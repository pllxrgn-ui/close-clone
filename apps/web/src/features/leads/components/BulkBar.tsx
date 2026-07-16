import type { JSX } from 'react';
import { IconButton } from '../../../ui/index.ts';
import { XIcon } from '../icons.tsx';
import { LeadBulkActions } from '../../admin/index.ts';
import type { Lead } from '@switchboard/shared';

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
        <LeadBulkActions selectedLeads={selectedLeads} onDone={onClear} />
      </div>
      <IconButton label="Clear selection" onClick={onClear} className="bulk-bar__clear">
        <XIcon size={16} />
      </IconButton>
    </div>
  );
}
