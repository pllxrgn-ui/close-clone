import { useId, useState } from 'react';
import type { JSX } from 'react';
import { Button, Input } from '../../../ui/index.ts';
import { Modal } from '../../../ui/Modal.tsx';
import { DNC_REASONS } from '../types.ts';
import { WarnIcon } from '../icons.tsx';

/*
 * Bulk-bar DNC dialog. Composes the shared Modal primitive (portal, focus trap,
 * Escape, focus restore) so it opens instantly (0ms) — safe for keyboard-first
 * use, per the motion law. The owner/status/sequence pickers are inline
 * Comboboxes in LeadBulkActions; only the required-reason DNC gate stays a modal.
 */

interface DncReasonDialogProps {
  open: boolean;
  mode: 'set' | 'clear';
  count: number;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

/**
 * The required-reason gate for a DNC set/clear. A reason is mandatory (it becomes
 * the audit rationale, C1 audit_log.reason) — Confirm stays disabled until one is
 * present, so a DNC flip can never be silent.
 */
export function DncReasonDialog({
  open,
  mode,
  count,
  onConfirm,
  onClose,
}: DncReasonDialogProps): JSX.Element | null {
  const headingId = useId();
  const descId = useId();
  const [choice, setChoice] = useState<string>('');
  const [other, setOther] = useState('');

  const resolved = choice === 'Other' ? other.trim() : choice;
  const verb = mode === 'set' ? 'Mark Do Not Contact' : 'Clear Do Not Contact';

  if (!open) return null;

  const submit = (): void => {
    if (resolved.length === 0) return;
    onConfirm(resolved);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={headingId}
      describedBy={descId}
      className="admin-dialog"
      backdropClassName="sb-overlay--center"
    >
      <div className="admin-dialog__head">
        <h2 id={headingId} className="admin-dialog__title">
          <WarnIcon size={15} className="admin-dialog__title-icon" />
          {verb}
        </h2>
        <p id={descId} className="admin-dialog__desc">
          {mode === 'set'
            ? `Suppress outreach to ${count.toLocaleString('en-US')} ${count === 1 ? 'lead' : 'leads'}. A reason is required for the audit log.`
            : `Re-enable outreach to ${count.toLocaleString('en-US')} ${count === 1 ? 'lead' : 'leads'}. A reason is required for the audit log.`}
        </p>
      </div>

      <fieldset className="admin-dnc__reasons">
        <legend className="sb-visually-hidden">Reason</legend>
        {DNC_REASONS.map((reason) => (
          <label key={reason} className="admin-dnc__reason">
            <input
              type="radio"
              name="dnc-reason"
              value={reason}
              checked={choice === reason}
              onChange={() => setChoice(reason)}
            />
            <span>{reason}</span>
          </label>
        ))}
      </fieldset>
      {choice === 'Other' ? (
        <div className="admin-dnc__other">
          <Input
            aria-label="Reason detail"
            placeholder="Add a short reason…"
            value={other}
            autoFocus
            onChange={(e) => setOther(e.target.value)}
          />
        </div>
      ) : null}

      <div className="admin-dialog__actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={mode === 'set' ? 'danger' : 'primary'}
          disabled={resolved.length === 0}
          onClick={submit}
        >
          {verb}
        </Button>
      </div>
    </Modal>
  );
}
