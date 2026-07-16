import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { AppProviders } from '../../app/AppProviders.tsx';
import { AppShell } from '../../app/AppShell.tsx';
import { server } from '../../mocks/server.ts';
import { LeadDetailRoutePage } from './pages/routes.tsx';
import { leadDetailHandlers } from './mocks/leadHandlers.ts';
import { makeLead } from './test/factories.ts';

/*
 * Global-search flow: the W2 command palette (⌘K) does typeahead over
 * GET /search grouped by lead/contact, and Enter navigates to the lead page. This
 * verifies the whole path end-to-end with the leads feature as the destination:
 * open palette → search → select → land on the (W3) lead page.
 */

const api = (p: string): string => `*/api/v1${p}`;
const target = makeLead({ name: 'Zzyzx Analytics' });

function renderApp() {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>Home</div>} />
            <Route path="leads/:id" element={<LeadDetailRoutePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

afterEach(cleanup);

describe('global search → lead page', () => {
  test('command palette typeahead opens the selected lead', async () => {
    server.use(
      http.get(api('/users'), () => HttpResponse.json([])),
      http.get(api('/lead-statuses'), () => HttpResponse.json([])),
      http.get(api('/search'), () =>
        HttpResponse.json({
          items: [
            { type: 'lead', id: target.id, leadId: target.id, title: target.name, subtitle: 'Qualified' },
          ],
        }),
      ),
      http.get(api('/leads/:id/timeline'), () => HttpResponse.json({ items: [] })),
      http.get(api('/leads/:id'), ({ params }) =>
        params.id === target.id
          ? HttpResponse.json(target)
          : HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 }),
      ),
      ...leadDetailHandlers,
    );

    renderApp();

    // Open the palette (⌘K equivalent) and search.
    await userEvent.click(screen.getByRole('button', { name: 'Open command palette' }));
    const input = screen.getByRole('combobox', { name: 'Command palette' });
    await userEvent.type(input, 'Zzyzx');

    // The lead surfaces as a grouped result; selecting it navigates to the page.
    const option = await screen.findByRole('option', { name: 'Zzyzx Analytics' });
    await userEvent.click(option);

    expect(
      await screen.findByRole('heading', { name: 'Zzyzx Analytics', level: 1 }),
    ).toBeInTheDocument();
  });
});
