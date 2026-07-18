import { useId, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Button, Field, Textarea } from '../../../ui/index.ts';
import { CALL_OUTCOMES } from '../lib/presets.ts';
import { formatCallDuration } from '../lib/duration.ts';

/*
 * The hang-up wrap-up: pick an outcome disposition, optionally type a rep note,
 * and log the call (PATCH /calls/:id). The note is rep-authored — this panel
 * never writes AI output, so it stays outside the §I-AI confirm rail. Save is
 * disabled until an outcome is chosen; the note is optional.
 */

export interface OutcomePanelProps {
  leadName: string;
  number: string;
  /** Final call length in whole seconds (frozen at hang-up), if answered. */
  durationS: number | null;
  onSave: (input: { outcome: string; notes?: string }) => Promise<boolean>;
  onDiscard: () => void;
}

export function OutcomePanel({
  leadName,
  number,
  durationS,
  onSave,
  onDiscard,
}: OutcomePanelProps): JSX.Element {
  const [outcome, setOutcome] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const groupLabelId = useId();
  const firstChipRef = useRef<HTMLButtonElement | null>(null);

  async function handleSave(): Promise<void> {
    if (outcome === null || saving) return;
    setSaving(true);
    const ok = await onSave({ outcome, ...(notes.trim().length > 0 ? { notes } : {}) });
    if (!ok) setSaving(false); // success unmounts the panel; only reset on failure
  }

  return (
    <div className="call-wrap">
      <div className="call-wrap__head">
        <span className="call-wrap__title">Log call</span>
        <span className="call-wrap__who">
          {leadName} · <span className="call-wrap__num">{number}</span>
          {durationS !== null ? (
            <>
              {' · '}
              <span className="call-wrap__dur">{formatCallDuration(durationS)}</span>
            </>
          ) : null}
        </span>
      </div>

      <div className="call-wrap__outcomes" role="group" aria-labelledby={groupLabelId}>
        <span id={groupLabelId} className="call-wrap__field-label">
          Outcome
        </span>
        <div className="call-wrap__chips">
          {CALL_OUTCOMES.map((option, index) => (
            <button
              key={option.id}
              ref={index === 0 ? firstChipRef : undefined}
              type="button"
              className="call-chip"
              aria-pressed={outcome === option.label}
              onClick={() => setOutcome((prev) => (prev === option.label ? null : option.label))}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <Field label="Note (optional)" className="call-wrap__note">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="What happened on the call?"
        />
      </Field>

      <div className="call-wrap__actions">
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button size="sm" onClick={handleSave} disabled={outcome === null} loading={saving}>
          Log call
        </Button>
      </div>
    </div>
  );
}
