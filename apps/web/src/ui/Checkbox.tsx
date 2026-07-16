import { forwardRef, useEffect, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import { useFieldControl } from './fieldContext.ts';
import { CheckIcon, MinusIcon } from './icons.tsx';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Inline label rendered next to the box (clicking it toggles). */
  label?: ReactNode;
  /** Mixed state for "some selected" (e.g. bulk-select headers). */
  indeterminate?: boolean;
  invalid?: boolean;
}

/**
 * Native-input checkbox (forms, keyboard and screen readers all work for free)
 * with an Operator Grid box drawn on top. The input stays in the tree,
 * visually hidden; :checked/:indeterminate/:focus-visible drive the visuals.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, indeterminate = false, invalid, className, disabled, id, ...rest },
  ref,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  const field = useFieldControl({
    id,
    invalid,
    describedBy: rest['aria-describedby'],
  });

  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className={cx('sb-check', className)} data-disabled={disabled || undefined}>
      <input
        {...rest}
        ref={(node) => {
          innerRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        type="checkbox"
        id={field.id}
        disabled={disabled}
        aria-invalid={field.invalid || undefined}
        aria-describedby={field.describedBy}
        className="sb-check__input"
      />
      <span className="sb-check__box" aria-hidden="true">
        <span className="sb-check__mark">
          <CheckIcon size={12} />
        </span>
        <span className="sb-check__dash">
          <MinusIcon size={12} />
        </span>
      </span>
      {label !== undefined && label !== null ? (
        <span className="sb-check__label">{label}</span>
      ) : null}
    </label>
  );
});
