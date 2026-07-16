import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../../../lib/cx.ts';
import {
  AboutIcon,
  ComplianceIcon,
  CustomFieldsIcon,
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
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: 'users', label: 'Users', icon: UsersIcon },
  { id: 'custom-fields', label: 'Custom fields', icon: CustomFieldsIcon },
  { id: 'templates', label: 'Templates & snippets', icon: TemplatesIcon },
  { id: 'compliance', label: 'Compliance', icon: ComplianceIcon },
  { id: 'about', label: 'About', icon: AboutIcon },
];

export const DEFAULT_SECTION = 'users';

/** Resolve a `?section=` value to a known section id, falling back to default. */
export function resolveSection(raw: string | null): string {
  return SETTINGS_SECTIONS.some((s) => s.id === raw) ? (raw as string) : DEFAULT_SECTION;
}

interface SettingsNavProps {
  active: string;
}

export function SettingsNav({ active }: SettingsNavProps): JSX.Element {
  return (
    <nav className="admin-subrail" aria-label="Settings sections">
      <p className="admin-subrail__label">Settings</p>
      <ul className="admin-subrail__list">
        {SETTINGS_SECTIONS.map((section) => {
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
