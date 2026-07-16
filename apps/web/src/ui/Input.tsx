import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cx } from '../lib/cx.ts';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, type = 'text', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cx('sb-input', className)}
      {...rest}
    />
  );
});
