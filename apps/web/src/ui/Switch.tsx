import { useContext, useEffect } from 'react';
import type { JSX, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import { FieldContext } from './fieldContext.ts';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible inline label; clicking it toggles. Without it, pass aria-label. */
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

/**
 * Controlled on/off toggle (role=switch) for immediate-effect settings —
 * unlike Checkbox it is NOT a form value, it applies as soon as it flips.
 * Achromatic like all chrome: the checked track is ink, never a state color.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  id,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SwitchProps): JSX.Element {
  // Inside a Field, adopt the generated control id so the Field label's
  // htmlFor resolves (button is a labelable element). Explicit id wins.
  const fieldContext = useContext(FieldContext);
  const resolvedId = id ?? fieldContext?.controlId;

  useEffect(() => {
    if (import.meta.env.DEV && fieldContext && label !== undefined && label !== null) {
      console.warn(
        'Switch: omit the `label` prop inside <Field> — the Field label already names the switch, and two labels concatenate the accessible name.',
      );
    }
  }, [fieldContext, label]);

  const button = (
    <button
      type="button"
      role="switch"
      id={resolvedId}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      className={cx('sb-switch', label === undefined && className)}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="sb-switch__thumb" aria-hidden="true" />
    </button>
  );
  if (label === undefined || label === null) return button;
  return (
    <label className={cx('sb-switch-field', className)} data-disabled={disabled || undefined}>
      <span className="sb-switch-field__label">{label}</span>
      {button}
    </label>
  );
}
