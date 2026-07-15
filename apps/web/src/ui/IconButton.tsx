import type { ButtonHTMLAttributes, JSX } from 'react';
import { cx } from '../lib/cx.ts';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only controls must carry an accessible name. */
  label: string;
  size?: 'sm' | 'md';
}

export function IconButton({
  label,
  size = 'md',
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps): JSX.Element {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx('sb-iconbtn', size === 'sm' && 'sb-iconbtn--sm', className)}
      {...rest}
    >
      {children}
    </button>
  );
}
