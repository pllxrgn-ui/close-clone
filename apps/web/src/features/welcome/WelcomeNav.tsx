import { useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { BoardMark, MenuIcon, XIcon } from './icons.tsx';
import { LOGIN_PATH, NAV_MENU, NAV_SIGN_IN, WORDMARK } from './copy.ts';

/*
 * Landing top bar: wordmark · section anchors · sign-in. On narrow viewports
 * the anchors + sign-in collapse behind a hamburger into a dropdown panel
 * (pointer-summoned → the panel's 180ms entrance is CSS-only and dies under
 * reduced motion). Anchor clicks close the panel; every target is a real
 * section on this page.
 */
export function WelcomeNav(): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <nav className="sb-welcome__nav" aria-label="Landing" data-open={open || undefined}>
      <span className="sb-welcome__wordmark">
        <BoardMark className="sb-welcome__wordmark-mark" />
        <span className="sb-welcome__wordmark-text">{WORDMARK}</span>
      </span>

      <button
        type="button"
        className="sb-welcome__nav-toggle"
        aria-expanded={open}
        aria-controls="welcome-nav-menu"
        aria-label={open ? 'Close menu' : 'Open menu'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <XIcon size={20} /> : <MenuIcon size={20} />}
      </button>

      <div id="welcome-nav-menu" className="sb-welcome__nav-menu">
        <ul className="sb-welcome__nav-links">
          {NAV_MENU.map((item) => (
            <li key={item.href}>
              <a href={item.href} className="sb-welcome__nav-link" onClick={() => setOpen(false)}>
                {item.name}
              </a>
            </li>
          ))}
        </ul>
        <Link to={LOGIN_PATH} className="sb-welcome__signin" onClick={() => setOpen(false)}>
          {NAV_SIGN_IN}
        </Link>
      </div>
    </nav>
  );
}
