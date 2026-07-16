import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { cx } from '../lib/cx.ts';
import { useFieldControl } from './fieldContext.ts';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, rows = 3, id, 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const field = useFieldControl({ id, invalid, describedBy });
  return (
    <textarea
      ref={ref}
      rows={rows}
      id={field.id}
      aria-invalid={field.invalid || undefined}
      aria-describedby={field.describedBy}
      className={cx('sb-textarea', className)}
      {...rest}
    />
  );
});
