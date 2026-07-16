import type { JSX } from 'react';
import { ReportsSurface } from '../components/ReportsSurface.tsx';
import '../reports.css';

/*
 * Route entry for the reporting surface. Exported from the feature dir so the app
 * router mounts it without importing internals — it replaces the phase-1
 * placeholder at /reports (see the task's routeWiring).
 */
export function ReportsRoutePage(): JSX.Element {
  return <ReportsSurface />;
}
