import type { JSX } from 'react';
import { Link } from 'react-router-dom';

export function NotFoundPage(): JSX.Element {
  return (
    <div className="sb-page sb-notfound">
      <p className="sb-notfound__code display" aria-hidden="true">
        404
      </p>
      <h1 className="sb-notfound__title">Page not found</h1>
      <p className="sb-notfound__hint">That route doesn’t exist in Switchboard.</p>
      <Link to="/inbox" className="sb-btn sb-btn--primary">
        Back to Inbox
      </Link>
    </div>
  );
}
