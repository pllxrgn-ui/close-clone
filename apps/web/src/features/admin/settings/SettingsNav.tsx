import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../../../lib/cx.ts';
import {
  AboutIcon,
  ComplianceIcon,
  CustomFieldsIcon,
  InboxesIcon,
  type IconProps,
  TemplatesIcon,
  UsersIcon,
} from '../icons.tsx';

/*
 * The settings left sub-rail (Operator Grid: dense 36px rows, wide-caps section
 * label, achromatic chrome). Sections are addressed by `?section=` so the whole
 * surface lives on the single committed `/settings` route — the merge only swaps
 * the lazy import, no router path change (see routeWiring).
 */

export interface SettingsSectionMeta {
  id: string;
  label: string;
  icon: (props: IconProps) => JSX.Element;
  adminOnly?: boolean;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: 'inboxes', label: 'Inboxes', icon: InboxesIcon },
  { id: 'users', label: 'Users', icon: UsersIcon, adminOnly: true },
  { id: 'custom-fields', label: 'Custom fields', icon: CustomFieldsIcon, adminOnly: true },
  { id: 'templates', label: 'Templates & snippets', icon: TemplatesIcon, adminOnly: true },
  { id: 'compliance', label: 'Compliance', icon: ComplianceIcon, adminOnly: true },
  { id: 'about', label: 'About', icon: AboutIcon },
];

export const DEFAULT_SECTION = 'inboxes';

/** Resolve a `?section=` value to a known section id, falling back to default. */
export function resolveSection(raw: string | null, isAdmin: boolean): string {
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === raw);
  return section && (!section.adminOnly || isAdmin) ? section.id : DEFAULT_SECTION;
}

interface SettingsNavProps {
  active: string;
  isAdmin: boolean;
}

export function SettingsNav({ active, isAdmin }: SettingsNavProps): JSX.Element {
  return (
    <nav className="admin-subrail" aria-label="Settings sections">
      <p className="admin-subrail__label">Settings</p>
      <ul className="admin-subrail__list">
        {SETTINGS_SECTIONS.filter((section) => isAdmin || !section.adminOnly).map((section) => {
          const Icon = section.icon;
          const isActive = section.id === active;
          return (
            <li key={section.id}>
              <Link
                to={`?section=${section.id}`}
                replace
                className={cx('admin-subrail__item', isActive && 'is-active')}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon size={15} className="admin-subrail__icon" />
                <span>{section.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
