import type { IconProps } from '../ui/icons.tsx';
import { InboxIcon, LeadsIcon, ReportsIcon, SettingsIcon, ViewsIcon } from '../ui/icons.tsx';

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
  { to: '/views', label: 'Views', key: 'v', icon: ViewsIcon },
  { to: '/reports', label: 'Reports', key: 'r', icon: ReportsIcon },
  { to: '/settings', label: 'Settings', key: 's', icon: SettingsIcon },
];

/** `g <key>` chord destinations, derived from NAV_ITEMS. */
export const NAV_CHORD_KEYS: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.key, item.to]),
);
