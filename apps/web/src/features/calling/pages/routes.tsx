import type { JSX } from 'react';
import { ListDialer } from './ListDialer.tsx';
import '../calling.css';

/*
 * Route entry point for the calling surface, exported from the feature index so
 * the app router can mount it without importing internals (see routeWiring):
 *   <Route path="dialer" element={<DialerRoutePage />} />
 */

/** /dialer — the sequential list dialer. */
export function DialerRoutePage(): JSX.Element {
  return <ListDialer />;
}
