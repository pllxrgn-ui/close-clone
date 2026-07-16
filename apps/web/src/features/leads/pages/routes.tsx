import type { JSX } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { LeadsSurface } from '../components/LeadsSurface.tsx';
import { LeadDetail } from '../components/LeadDetail.tsx';
import '../leads.css';

/*
 * Route entry points for the leads surface. Exported from the feature dir so the
 * app router can mount them without importing internals; see the task's
 * routeWiring for the exact wiring (these replace the phase-1 placeholder pages
 * at /leads, /views/:id, and /leads/:id).
 */

/** /leads — the Smart-View-driven surface with no view selected ("All leads"). */
export function LeadsRoutePage(): JSX.Element {
  return <LeadsSurface viewId={null} />;
}

/** /views/:id — the same surface bound to a saved Smart View. */
export function ViewRoutePage(): JSX.Element {
  const { id } = useParams();
  return <LeadsSurface viewId={id ?? null} />;
}

/** /leads/:id — the lead page (header, timeline, right rail). */
export function LeadDetailRoutePage(): JSX.Element {
  const { id } = useParams();
  if (!id) return <Navigate to="/leads" replace />;
  return <LeadDetail leadId={id} />;
}
