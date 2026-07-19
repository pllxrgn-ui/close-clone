import type { JSX } from 'react';
import { NavLink } from 'react-router-dom';
import { cx } from '../lib/cx.ts';
import { Tooltip } from '../ui/index.ts';
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from '../ui/icons.tsx';
import { KbdCombo } from '../keyboard/index.ts';
import { FOOTER_NAV, PRIMARY_NAV } from './nav.tsx';
import type { NavItem } from './nav.tsx';

/*
 * Primary navigation. Two groups: the daily work surfaces on top, then a
 * hairline and the about-the-tool group (Support & FAQs, Settings) pinned to
 * the bottom, with the collapse control last.
 *
 * Links are natively keyboardable; active state via aria-current (NavLink).
 * Shortcut chords render from the same combo strings the keyboard registry
 * binds (one source of truth for hints). Collapsed, the rail is icon-only and
 * each item names itself through a Tooltip — the label leaves the DOM, so the
 * accessible name comes from the link's own aria-label, never the tooltip.
 */

interface RailLinkProps {
  item: NavItem;
  collapsed: boolean;
}

function RailLink({ item, collapsed }: RailLinkProps): JSX.Element {
  const Icon = item.icon;
  const link = (
    <NavLink
      to={item.to}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) => cx('sb-rail__item', isActive && 'is-active')}
    >
      <Icon size={16} className="sb-rail__icon" />
      {collapsed ? null : (
        <>
          <span className="sb-rail__label">{item.label}</span>
          <KbdCombo combo={`g ${item.key}`} className="sb-rail__kbd" />
        </>
      )}
    </NavLink>
  );
  if (!collapsed) return link;
  return (
    <Tooltip side="bottom" content={item.label}>
      {link}
    </Tooltip>
  );
}

interface LeftRailProps {
  collapsed: boolean;
  /** Viewport-forced collapse — hides the toggle (the state is not a preference). */
  forcedCollapsed?: boolean;
  onToggleCollapse: () => void;
}

export function LeftRail({
  collapsed,
  forcedCollapsed = false,
  onToggleCollapse,
}: LeftRailProps): JSX.Element {
  return (
    <nav className="sb-rail" aria-label="Primary" data-collapsed={collapsed || undefined}>
      <ul className="sb-rail__list">
        {PRIMARY_NAV.map((item) => (
          <li key={item.to}>
            <RailLink item={item} collapsed={collapsed} />
          </li>
        ))}
      </ul>

      <div className="sb-rail__foot">
        <ul className="sb-rail__list">
          {FOOTER_NAV.map((item) => (
            <li key={item.to}>
              <RailLink item={item} collapsed={collapsed} />
            </li>
          ))}
        </ul>

        {forcedCollapsed ? null : (
          <button
            type="button"
            className="sb-rail__collapse"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? (
              <PanelLeftOpenIcon size={16} className="sb-rail__icon" />
            ) : (
              <PanelLeftCloseIcon size={16} className="sb-rail__icon" />
            )}
            {collapsed ? null : <span className="sb-rail__label">Collapse</span>}
          </button>
        )}
      </div>
    </nav>
  );
}
