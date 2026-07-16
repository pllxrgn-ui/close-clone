import { useId, useMemo } from 'react';
import type { JSX, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import { FieldContext } from './fieldContext.ts';
import type { FieldContextValue } from './fieldContext.ts';

export interface FieldProps {
  /** Visible label, associated with the control via htmlFor. */
  label: ReactNode;
  /** Helper text below the control; stays visible alongside an error. */
  hint?: ReactNode;
  /** Error message; its presence marks the control invalid (announced via role=alert). */
  error?: ReactNode;
  /** Marks the label with a required indicator (visual; put `required` on the control too). */
  required?: boolean;
  /** Control id override; generated when omitted. */
  id?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Form-field wrapper: label + control + hint + error with all aria wiring
 * (htmlFor, aria-describedby, aria-invalid) done through FieldContext, so the
 * child control needs no ids. Works with Input, Textarea, Select, Checkbox;
 * explicit props on the control override the context.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  id,
  className,
  children,
}: FieldProps): JSX.Element {
  const baseId = useId();
  const controlId = id ?? `${baseId}-control`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const hasError = error !== undefined && error !== null && error !== false;

  const context = useMemo<FieldContextValue>(() => {
    const describedBy =
      cx(hint !== undefined && hint !== null ? hintId : false, hasError ? errorId : false) ||
      undefined;
    return { controlId, describedBy, invalid: hasError };
  }, [controlId, hint, hintId, hasError, errorId]);

  return (
    <div className={cx('sb-field', className)} data-invalid={hasError || undefined}>
      <label className="sb-field__label" htmlFor={controlId}>
        {label}
        {required ? (
          <span className="sb-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <FieldContext.Provider value={context}>{children}</FieldContext.Provider>
      {hint !== undefined && hint !== null ? (
        <p id={hintId} className="sb-field__hint">
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="sb-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
