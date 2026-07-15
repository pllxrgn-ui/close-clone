import type { JSX } from 'react';
import { cx } from '../lib/cx.ts';
import { VisuallyHidden } from './VisuallyHidden.tsx';

interface SpinnerProps {
  size?: 'sm' | 'lg';
  /** Accessible loading label (announced via role="status"). */
  label?: string;
  className?: string;
}

export function Spinner({ size = 'sm', label = 'Loading', className }: SpinnerProps): JSX.Element {
  return (
    <span role="status" className={className}>
      <span className={cx('sb-spinner', size === 'lg' && 'sb-spinner--lg')} aria-hidden="true" />
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}
