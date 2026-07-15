import type { JSX, ReactNode } from 'react';

/** Screen-reader-only content: removed from view, kept in the a11y tree. */
export function VisuallyHidden({ children }: { children: ReactNode }): JSX.Element {
  return <span className="sb-visually-hidden">{children}</span>;
}
