import type { JSX, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';

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
  const button = (
    <button
      type="button"
      role="switch"
      id={id}
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
