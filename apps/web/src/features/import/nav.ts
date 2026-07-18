import type { NavItem } from '../../app/nav.tsx';
import { UploadIcon } from './icons.tsx';

/*
 * Rail entry for the import wizard. Exported for the orchestrator to fold into
 * the app nav (see routeWiring) — placement (primary vs. footer near Settings)
 * and the `g m` chord key are the orchestrator's call; `m` (iMport) is free
 * today (i/l/p/v/r/h/s are taken).
 */
export const importNavItem: NavItem = {
  to: '/import',
  label: 'Import',
  key: 'm',
  icon: UploadIcon,
};
