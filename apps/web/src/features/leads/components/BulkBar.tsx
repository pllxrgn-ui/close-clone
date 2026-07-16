import type { JSX } from 'react';
import { Button, IconButton } from '../../../ui/index.ts';
import { BranchIcon, MailIcon, TargetIcon, UploadIcon, XIcon } from '../icons.tsx';

/*
 * Bulk-action bar shown when one or more leads are selected. Every action is a
 * disabled placeholder explicitly labelled for Phase 4 (the bulk engine + C6
 * compliance rails land there) — nothing here mutates records or bypasses a rail.
 * Only "Clear selection" is live.
 */

interface BulkBarProps {
  count: number;
  onClear: () => void;
}

const PHASE4_ACTIONS: ReadonlyArray<{
  id: string;
  label: string;
  icon: (props: { size?: number }) => JSX.Element;
}> = [
  { id: 'sequence', label: 'Add to sequence', icon: BranchIcon },
  { id: 'email', label: 'Send email', icon: MailIcon },
  { id: 'status', label: 'Set status', icon: TargetIcon },
  { id: 'export', label: 'Export', icon: UploadIcon },
];

export function BulkBar({ count, onClear }: BulkBarProps): JSX.Element | null {
  if (count <= 0) return null;
  return (
    <div className="bulk-bar" role="region" aria-label={`${count} leads selected`}>
      <span className="bulk-bar__count" aria-live="polite">
        <strong>{count.toLocaleString('en-US')}</strong> selected
      </span>
      <div className="bulk-bar__actions">
        {PHASE4_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <Button
              key={action.id}
              size="sm"
              variant="ghost"
              disabled
              title={`${action.label} — available in Phase 4`}
              aria-label={`${action.label} (available in Phase 4)`}
            >
              <Icon size={14} />
              {action.label}
            </Button>
          );
        })}
      </div>
      <IconButton label="Clear selection" onClick={onClear} className="bulk-bar__clear">
        <XIcon size={16} />
      </IconButton>
    </div>
  );
}
