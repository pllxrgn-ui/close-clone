import type { JSX } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { SequencesList } from '../components/SequencesList.tsx';
import { SequenceDetail } from '../components/SequenceDetail.tsx';
import '../comms.css';

/*
 * Route entry points for the comms sequences surface. Exported from the feature
 * index so the app router can mount them without importing internals (see the
 * task's routeWiring):
 *   <Route path="sequences" element={<SequencesRoutePage />} />
 *   <Route path="sequences/:id" element={<SequenceDetailRoutePage />} />
 */

/** /sequences — the sequence list. */
export function SequencesRoutePage(): JSX.Element {
  return <SequencesList />;
}

/** /sequences/:id — the step ladder + roster + enroll. */
export function SequenceDetailRoutePage(): JSX.Element {
  const { id } = useParams();
  if (!id) return <Navigate to="/sequences" replace />;
  return <SequenceDetail sequenceId={id} />;
}
