import type { JSX, SelectHTMLAttributes } from 'react';
import { cx } from '../lib/cx.ts';
import { ChevronDownIcon } from './icons.tsx';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export function Select({ invalid, className, children, ...rest }: SelectProps): JSX.Element {
  return (
    <span className="sb-select-wrap">
      <select aria-invalid={invalid || undefined} className={cx('sb-select', className)} {...rest}>
        {children}
      </select>
      <ChevronDownIcon className="sb-select-wrap__chevron" size={14} />
    </span>
  );
}
