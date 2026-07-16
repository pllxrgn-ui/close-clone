import type { JSX } from 'react';
import { NavLink } from 'react-router-dom';
import { cx } from '../lib/cx.ts';
import { KbdCombo } from '../keyboard/index.ts';
import { NAV_ITEMS } from './nav.tsx';

/** Primary navigation. Links are natively keyboardable; active state via
 *  aria-current (NavLink). Shortcut chords are rendered from the same combo
 *  strings the keyboard registry binds (single source of truth for hints). */
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
                <KbdCombo combo={`g ${item.key}`} className="sb-rail__kbd" />
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
