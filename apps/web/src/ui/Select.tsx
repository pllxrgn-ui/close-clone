import type { JSX, SelectHTMLAttributes } from 'react';
import { cx } from '../lib/cx.ts';
import { useFieldControl } from './fieldContext.ts';
import { ChevronDownIcon } from './icons.tsx';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export function Select({
  invalid,
  className,
  children,
  id,
  'aria-describedby': describedBy,
  ...rest
}: SelectProps): JSX.Element {
  const field = useFieldControl({ id, invalid, describedBy });
  return (
    <span className="sb-select-wrap">
      <select
        id={field.id}
        aria-invalid={field.invalid || undefined}
        aria-describedby={field.describedBy}
        className={cx('sb-select', className)}
        {...rest}
      >
        {children}
      </select>
      <ChevronDownIcon className="sb-select-wrap__chevron" size={14} />
    </span>
  );
}
