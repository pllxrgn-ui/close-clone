import type { JSX } from 'react';
import type { IconProps } from '../ui/icons.tsx';
import { InboxIcon, LeadsIcon, ReportsIcon, SettingsIcon, ViewsIcon } from '../ui/icons.tsx';

/** Kanban glyph for the Pipeline rail item (lucide-style, stroke 1.5). */
function PipelineIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="10" rx="1" />
      <rect x="17" y="4" width="4" height="13" rx="1" />
    </svg>
  );
}

export interface NavItem {
  to: string;
  label: string;
  /** Second key of the `g <key>` navigation chord. */
  key: string;
  icon: (props: IconProps) => import('react').JSX.Element;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/inbox', label: 'Inbox', key: 'i', icon: InboxIcon },
  { to: '/leads', label: 'Leads', key: 'l', icon: LeadsIcon },
  { to: '/pipeline', label: 'Pipeline', key: 'p', icon: PipelineIcon },
  { to: '/views', label: 'Views', key: 'v', icon: ViewsIcon },
  { to: '/reports', label: 'Reports', key: 'r', icon: ReportsIcon },
  { to: '/settings', label: 'Settings', key: 's', icon: SettingsIcon },
];

/** `g <key>` chord destinations, derived from NAV_ITEMS. */
export const NAV_CHORD_KEYS: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.key, item.to]),
);
