import type { ButtonHTMLAttributes, JSX } from 'react';
import { cx } from '../lib/cx.ts';
import { Spinner } from './Spinner.tsx';

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      type={type}
      className={cx(
        'sb-btn',
        variant !== 'default' && `sb-btn--${variant}`,
        size !== 'md' && `sb-btn--${size}`,
        className,
      )}
      disabled={disabled === true || loading}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      {...rest}
    >
      {children}
      {loading ? (
        <span className="sb-btn__spinner">
          <Spinner label="Working" />
        </span>
      ) : null}
    </button>
  );
}
