import { useId, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Button, Input, ListRow } from '../../../ui/index.ts';
import { Modal } from '../../../ui/Modal.tsx';
import { DNC_REASONS } from '../types.ts';
import { WarnIcon } from '../icons.tsx';

/*
 * Bulk-bar dialogs. All compose the shared Modal primitive (portal, focus trap,
 * Escape, focus restore) so they open instantly (0ms) — safe for keyboard-first
 * use, per the motion law. Every control is reachable and operable by keyboard.
 */

export interface SelectOption {
  id: string;
  label: string;
  sublabel?: string;
  /** CSS color for the row's leading state bar (e.g. a status/DNC tone). */
  accent?: string;
}

interface SelectDialogProps {
  open: boolean;
  title: string;
  options: readonly SelectOption[];
  onSelect: (id: string) => void;
  onClose: () => void;
  emptyLabel?: string;
}

/** A filterable single-select dialog used for owner / status / sequence pickers. */
export function SelectDialog({
  open,
  title,
  options,
  onSelect,
  onClose,
  emptyLabel = 'Nothing to choose from.',
}: SelectDialogProps): JSX.Element | null {
  const headingId = useId();
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [filter, setFilter] = useState('');
  const showFilter = options.length > 7;

  const shown = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(term) || (o.sublabel?.toLowerCase().includes(term) ?? false),
    );
  }, [options, filter]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={headingId}
      className="admin-dialog"
      backdropClassName="sb-overlay--center"
      {...(showFilter ? { initialFocusRef: filterRef } : {})}
    >
      <div className="admin-dialog__head">
        <h2 id={headingId} className="admin-dialog__title">
          {title}
        </h2>
      </div>
      {showFilter ? (
        <div className="admin-dialog__filter">
          <Input
            ref={filterRef}
            type="search"
            aria-label={`Filter ${title.toLowerCase()}`}
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      ) : null}
      <div className="admin-dialog__list" role="list">
        {shown.length === 0 ? (
          <p className="admin-dialog__empty">{emptyLabel}</p>
        ) : (
          shown.map((option) => (
            <ListRow
              key={option.id}
              {...(option.accent ? { accent: option.accent } : {})}
              onSelect={() => onSelect(option.id)}
              ariaLabel={option.sublabel ? `${option.label}, ${option.sublabel}` : option.label}
              className="admin-pick-row"
            >
              <span className="admin-pick-row__label">{option.label}</span>
              {option.sublabel ? (
                <span className="admin-pick-row__sub">{option.sublabel}</span>
              ) : null}
            </ListRow>
          ))
        )}
      </div>
    </Modal>
  );
}

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
