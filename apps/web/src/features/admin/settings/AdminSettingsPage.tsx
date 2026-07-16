import type { JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import '../admin.css';
import { SettingsNav, resolveSection } from './SettingsNav.tsx';
import { UsersSection } from './sections/UsersSection.tsx';
import { CustomFieldsSection } from './sections/CustomFieldsSection.tsx';
import { TemplatesSection } from './sections/TemplatesSection.tsx';
import { ComplianceSection } from './sections/ComplianceSection.tsx';
import { AboutSection } from './sections/AboutSection.tsx';

/*
 * The /settings route surface (replaces the placeholder). A left sub-rail in the
 * Operator Grid style switches sections; the active section is addressed by
 * `?section=` so the whole surface lives on the single committed `/settings`
 * route — deep-linkable and keyboardable, with only the lazy import swapped at
 * merge (see routeWiring).
 */

function renderSection(section: string): JSX.Element {
  switch (section) {
    case 'custom-fields':
      return <CustomFieldsSection />;
    case 'templates':
      return <TemplatesSection />;
    case 'compliance':
      return <ComplianceSection />;
    case 'about':
      return <AboutSection />;
    case 'users':
    default:
      return <UsersSection />;
  }
}

export function AdminSettingsPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const active = resolveSection(searchParams.get('section'));

  return (
    <div className="admin-settings">
      <SettingsNav active={active} />
      <div className="admin-settings__content">{renderSection(active)}</div>
    </div>
  );
}
