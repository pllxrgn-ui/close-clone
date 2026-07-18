import type { JSX } from 'react';
import { ImportWizard } from '../components/ImportWizard.tsx';

/*
 * Route entry for the import wizard. Exported from the feature index so the app
 * router can mount it without importing internals (see routeWiring):
 *   <Route path="import" element={<ImportRoutePage />} />
 */
export function ImportRoutePage(): JSX.Element {
  return <ImportWizard />;
}
