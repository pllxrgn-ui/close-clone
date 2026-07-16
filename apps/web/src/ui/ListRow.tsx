import type { CSSProperties, JSX, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';

interface ListRowProps {
  children: ReactNode;
  /** Marks the row as the current selection (aria-current). */
  selected?: boolean;
  /** CSS color for the left state bar, e.g. `var(--state-overdue-solid)`. */
  accent?: string;
  /** When provided, the row renders as a real button (keyboard-operable). */
  onSelect?: () => void;
  ariaLabel?: string;
  className?: string;
}

/** A dense, focusable list row. Interactive when `onSelect` is given. */
export function ListRow({
  children,
  selected = false,
  accent,
  onSelect,
  ariaLabel,
  className,
}: ListRowProps): JSX.Element {
  const style = accent ? ({ '--row-accent': accent } as CSSProperties) : undefined;
  const cls = cx('sb-row', className);
  const current = selected ? 'true' : undefined;

  if (onSelect) {
    return (
      <button
        type="button"
        className={cls}
        style={style}
        data-accent={accent ? '' : undefined}
        aria-current={current}
        aria-label={ariaLabel}
        onClick={onSelect}
      >
        {children}
      </button>
    );
  }
  return (
    <div className={cls} style={style} data-accent={accent ? '' : undefined} aria-current={current}>
      {children}
    </div>
  );
}
