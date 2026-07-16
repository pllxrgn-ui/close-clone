import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { BoardMark } from './icons.tsx';
import { LOGIN_PATH, NAV_SIGN_IN, WORDMARK } from './copy.ts';

/** Landing top bar: the wordmark and a single sign-in affordance → dev-login. */
export function WelcomeNav(): JSX.Element {
  return (
    <nav className="sb-welcome__nav" aria-label="Landing">
      <span className="sb-welcome__wordmark">
        <BoardMark className="sb-welcome__wordmark-mark" />
        <span className="sb-welcome__wordmark-text">{WORDMARK}</span>
      </span>
      <Link to={LOGIN_PATH} className="sb-welcome__signin">
        {NAV_SIGN_IN}
      </Link>
    </nav>
  );
}
