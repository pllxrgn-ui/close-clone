import type { CSSProperties, JSX } from 'react';
import { cx } from '../lib/cx.ts';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string;
  className?: string;
}

function toCss(v: string | number): string {
  return typeof v === 'number' ? `${v}px` : v;
}

/** Decorative loading placeholder (aria-hidden — pair with a Spinner/status). */
export function Skeleton({ width, height = 12, radius, className }: SkeletonProps): JSX.Element {
  const style: CSSProperties = { height: toCss(height) };
  if (width !== undefined) style.width = toCss(width);
  if (radius !== undefined) style.borderRadius = radius;
  return <span className={cx('sb-skeleton', className)} style={style} aria-hidden="true" />;
}
