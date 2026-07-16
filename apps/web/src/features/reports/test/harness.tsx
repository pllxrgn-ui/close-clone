/*
 * Test seam for the reports feature: render a component under the providers it
 * needs (react-query, a MemoryRouter for useSearchParams, the keyboard registry
 * for route shortcuts). The MSW report handlers are installed per-test via
 * `server.use(...reportsHandlers)` in each spec (setup.ts resets between tests).
 */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KeyboardProvider } from '../../../keyboard/index.ts';
import { ROUTER_FUTURE } from '../../../app/routerFuture.ts';

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

export function renderReports(ui: ReactElement, route = '/reports'): RenderResult {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter initialEntries={[route]} future={ROUTER_FUTURE}>
        <KeyboardProvider>{ui}</KeyboardProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
