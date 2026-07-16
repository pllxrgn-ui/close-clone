import type { JSX } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AppProviders } from './app/AppProviders.tsx';
import { AppRoutes } from './app/AppRoutes.tsx';
import { ROUTER_FUTURE } from './app/routerFuture.ts';

/**
 * Composition root: providers (theme · react-query · auth) wrap the browser
 * router and the route tree. Kept thin so tests can mount AppRoutes under a
 * MemoryRouter with the same providers.
 */
export function App(): JSX.Element {
  return (
    <AppProviders>
      <BrowserRouter future={ROUTER_FUTURE}>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  );
}

export default App;
