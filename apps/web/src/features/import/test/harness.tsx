import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ROUTER_FUTURE } from '../../../app/routerFuture.ts';

/** MSW path helper matching the app's `/api/v1` base. */
export const api = (path: string): string => `*/api/v1${path}`;

/** Render an import UI inside the providers it needs (query · router). */
export function renderImport(ui: ReactElement, route = '/import'): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]} future={ROUTER_FUTURE}>
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
