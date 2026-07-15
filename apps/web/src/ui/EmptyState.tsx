import type { JSX, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Centered empty/zero-state block for lists and panes. */
export function EmptyState({
  title,
  description,
  icon,
  actions,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div className={cx('sb-empty', className)}>
      {icon ? (
        <div className="sb-empty__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <div className="sb-empty__title">{title}</div>
      {description ? <div className="sb-empty__desc">{description}</div> : null}
      {actions ? <div className="sb-empty__actions">{actions}</div> : null}
    </div>
  );
}
