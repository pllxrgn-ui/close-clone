import type { JSX, ReactNode } from 'react';

interface PageProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

/** Standard page frame: an h1 header row with optional subtitle/actions. */
export function Page({ title, subtitle, actions, children }: PageProps): JSX.Element {
  return (
    <div className="sb-page">
      <div className="sb-page__head">
        <div>
          <h1 className="sb-page__title">{title}</h1>
          {subtitle ? <p className="sb-page__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="sb-page__actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** A muted note used by the phase-1 placeholder pages. */
export function PlaceholderNote({ children }: { children: ReactNode }): JSX.Element {
  return <p className="sb-placeholder">{children}</p>;
}
