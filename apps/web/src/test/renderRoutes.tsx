import type { RenderResult } from '@testing-library/react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@switchboard/shared';
import { AppProviders } from '../app/AppProviders.tsx';
import { AppRoutes } from '../app/AppRoutes.tsx';
import { ROUTER_FUTURE } from '../app/routerFuture.ts';
import { storeUser } from '../auth/auth.ts';

/**
 * Render the full route tree under the real app providers at a given path, with
 * an optional pre-seeded auth session (written to localStorage before mount so
 * AuthProvider restores it). A MemoryRouter keeps each test isolated from jsdom
 * history; a fresh QueryClient per call prevents cache bleed.
 */
export function renderRoutes(path: string, options: { user?: User } = {}): RenderResult {
  storeUser(options.user ?? null);
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
}
