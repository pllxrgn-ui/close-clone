import type { JSX, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import { Button } from './Button.tsx';
import { EmptyState } from './EmptyState.tsx';
import { AlertTriangleIcon } from './icons.tsx';

export interface ErrorStateProps {
  title: string;
  /** What went wrong / what to try; keep it human, not a raw stack. */
  description?: ReactNode;
  /** Convenience retry: renders a standard Retry button wired to this. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Escape hatch for custom actions (rendered after the retry button). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Failure sibling of EmptyState for lists/panes whose data failed to load.
 * Announced via role=alert when it appears; always offer a way forward
 * (retry or an alternative action) — a dead end is not a state.
 */
export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel = 'Retry',
  actions,
  className,
}: ErrorStateProps): JSX.Element {
  const hasActions = onRetry !== undefined || actions !== undefined;
  return (
    <div role="alert">
      <EmptyState
        className={cx('sb-empty--error', className)}
        icon={<AlertTriangleIcon size={20} />}
        title={title}
        description={description}
        actions={
          hasActions ? (
            <>
              {onRetry ? <Button onClick={onRetry}>{retryLabel}</Button> : null}
              {actions}
            </>
          ) : undefined
        }
      />
    </div>
  );
}
