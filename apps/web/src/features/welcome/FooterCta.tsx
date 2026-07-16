import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { BoardMark } from './icons.tsx';
import { FOOTER, LOGIN_PATH, WORDMARK } from './copy.ts';

/** Closing CTA repeat + the internal-tool note. */
export function FooterCta(): JSX.Element {
  return (
    <footer className="sb-welcome__footer">
      <div className="sb-welcome__footer-main">
        <p className="sb-welcome__footer-kicker">The line’s open.</p>
        <Link to={LOGIN_PATH} className="sb-welcome__cta">
          {FOOTER.cta}
          <span className="sb-welcome__cta-arrow" aria-hidden="true">
            →
          </span>
        </Link>
      </div>
      <div className="sb-welcome__footer-fine">
        <span className="sb-welcome__footer-brand">
          <BoardMark size={16} />
          {WORDMARK}
        </span>
        <p className="sb-welcome__footer-note">{FOOTER.note}</p>
      </div>
    </footer>
  );
}
