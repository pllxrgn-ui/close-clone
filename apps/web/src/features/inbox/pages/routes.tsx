import type { JSX } from 'react';
import { InboxSurface } from '../components/InboxSurface.tsx';
import '../inbox.css';

/*
 * Route entry for the Inbox surface. Exported from the feature dir so the app
 * router mounts it without importing internals; see the task's routeWiring (it
 * replaces the phase-1 placeholder page at /inbox).
 */
export function InboxRoutePage(): JSX.Element {
  return <InboxSurface />;
}
