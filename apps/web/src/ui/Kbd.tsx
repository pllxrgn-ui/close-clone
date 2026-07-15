import type { JSX, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';

/** A keycap. Shows a shortcut inline next to an action (keyboard-first UI). */
export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <kbd className={cx('sb-kbd', className)}>{children}</kbd>;
}
