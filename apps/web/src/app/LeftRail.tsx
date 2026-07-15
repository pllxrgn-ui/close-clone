import type { JSX } from 'react';
import { NavLink } from 'react-router-dom';
import { cx } from '../lib/cx.ts';
import { Kbd } from '../ui/index.ts';
import { NAV_ITEMS } from './nav.ts';

/** Primary navigation. Links are natively keyboardable; active state via
 *  aria-current (NavLink). Shortcut chords shown inline until muscle memory. */
export function LeftRail(): JSX.Element {
  return (
    <nav className="sb-rail" aria-label="Primary">
      <ul className="sb-rail__list">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) => cx('sb-rail__item', isActive && 'is-active')}
              >
                <Icon size={16} className="sb-rail__icon" />
                <span className="sb-rail__label">{item.label}</span>
                <Kbd className="sb-rail__kbd">{`g ${item.key}`}</Kbd>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
