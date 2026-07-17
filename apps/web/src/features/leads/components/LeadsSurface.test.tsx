import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import type { Lead, SmartView } from '@switchboard/shared';
import { KeyboardProvider } from '../../../keyboard/index.ts';
import { ToastProvider } from '../../../feedback/index.ts';
import { server } from '../../../mocks/server.ts';
import { LeadsSurface } from './LeadsSurface.tsx';
import { makeLead, makeSmartView } from '../test/factories.ts';
import { installVirtualizerEnv } from '../test/harness.tsx';

const api = (p: string): string => `*/api/v1${p}`;

const viewA = makeSmartView({
  name: 'Alpha view',
  shared: true,
  dsl: 'status = "Qualified"',
  columns: ['name', 'status', 'owner'],
  sort: { field: 'name', dir: 'asc' },
});
const viewB = makeSmartView({
  name: 'Bravo view',
  shared: true,
  dsl: 'dnc = true',
  columns: ['name', 'dnc'],
  sort: null,
});
const leadsA = [makeLead({ name: 'Alpha Corp' }), makeLead({ name: 'Apex Two' })];
const leadsB = [makeLead({ name: 'Bravo Corp', dnc: true })];

function useReferenceHandlers(): void {
  server.use(
    http.get(api('/users'), () => HttpResponse.json([])),
    http.get(api('/lead-statuses'), () => HttpResponse.json([])),
  );
}

function ViewRoute(): JSX.Element {
  const { id } = useParams();
  return <LeadsSurface viewId={id ?? null} />;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <KeyboardProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/leads" element={<LeadsSurface viewId={null} />} />
              <Route path="/views/:id" element={<ViewRoute />} />
              <Route path="/leads/:id" element={<div data-testid="lead-detail" />} />
            </Routes>
          </MemoryRouter>
        </KeyboardProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = installVirtualizerEnv({ height: 640 });
});
afterEach(() => {
  restoreEnv();
  cleanup();
});

describe('LeadsSurface — All leads', () => {
  test('renders the keyset list from GET /leads with the default columns', async () => {
    useReferenceHandlers();
    const leads: Lead[] = [makeLead({ name: 'North Labs' }), makeLead({ name: 'Cedar Systems' })];
    server.use(http.get(api('/leads'), () => HttpResponse.json({ items: leads })));

    renderAt('/leads');

    expect(await screen.findByText('North Labs')).toBeInTheDocument();
    expect(screen.getByText('Cedar Systems')).toBeInTheDocument();
    // "All leads" is the active sidebar entry.
    expect(screen.getByRole('option', { name: /All leads/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('empty result shows the empty state', async () => {
    useReferenceHandlers();
    server.use(http.get(api('/leads'), () => HttpResponse.json({ items: [] })));
    renderAt('/leads');
    expect(await screen.findByText('No leads yet')).toBeInTheDocument();
  });

  test('a failed leads fetch shows a typed error with retry', async () => {
    useReferenceHandlers();
    server.use(
      http.get(api('/leads'), () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderAt('/leads');
    expect(await screen.findByText('Couldn’t load leads')).toBeInTheDocument();
    expect(screen.getByText(/INTERNAL/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('LeadsSurface — Smart View selection', () => {
  function installViewHandlers(): string[] {
    const previewDsls: string[] = [];
    useReferenceHandlers();
    server.use(
      http.get(api('/leads'), () => HttpResponse.json({ items: [] })),
      http.get(api('/smart-views'), () => HttpResponse.json([viewA, viewB])),
      http.get(api('/smart-views/:id'), ({ params }) => {
        const v: SmartView | null =
          params.id === viewA.id ? viewA : params.id === viewB.id ? viewB : null;
        return v
          ? HttpResponse.json(v)
          : HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 });
      }),
      http.post(api('/smart-views/preview'), async ({ request }) => {
        const body = (await request.json()) as { dsl?: string };
        const dsl = body.dsl ?? '';
        previewDsls.push(dsl);
        const items = dsl === viewA.dsl ? leadsA : dsl === viewB.dsl ? leadsB : [];
        return HttpResponse.json({ items, countEstimate: items.length });
      }),
    );
    return previewDsls;
  }

  test('selecting a view runs preview; switching re-queries with the new DSL', async () => {
    const previewDsls = installViewHandlers();
    renderAt('/leads');

    // Pick "Alpha view" → POST /smart-views/preview with view A's DSL.
    await userEvent.click(await screen.findByRole('option', { name: /Alpha view/ }));
    expect(await screen.findByText('Alpha Corp')).toBeInTheDocument();
    await waitFor(() => expect(previewDsls).toContain(viewA.dsl));

    // Switch to "Bravo view" → a fresh preview with view B's DSL (the re-query).
    await userEvent.click(screen.getByRole('option', { name: /Bravo view/ }));
    expect(await screen.findByText('Bravo Corp')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Corp')).toBeNull();

    expect(previewDsls).toEqual([viewA.dsl, viewB.dsl]);
    // The view's DSL is surfaced in the toolbar.
    expect(screen.getByText(viewB.dsl)).toBeInTheDocument();
  });

  test('preview failure surfaces a typed error', async () => {
    useReferenceHandlers();
    server.use(
      http.get(api('/smart-views'), () => HttpResponse.json([viewA])),
      http.get(api('/smart-views/:id'), () => HttpResponse.json(viewA)),
      http.post(api('/smart-views/preview'), () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_FAILED', message: 'bad dsl' } },
          { status: 400 },
        ),
      ),
    );
    renderAt(`/views/${viewA.id}`);
    expect(await screen.findByText('Couldn’t load leads')).toBeInTheDocument();
    expect(screen.getByText(/VALIDATION_FAILED/)).toBeInTheDocument();
  });
});

describe('LeadsSurface — partial-scope honesty (audit #3)', () => {
  // Sort/filter operate on loaded rows; with pages still unfetched the UI must
  // say so rather than imply a whole-dataset ordering.
  test('filtering while more pages exist shows the partial-scope note', async () => {
    useReferenceHandlers();
    const pageOne = Array.from({ length: 100 }, (_, i) =>
      makeLead({ name: `Lead ${String(i + 1).padStart(3, '0')}` }),
    );
    server.use(
      http.get(api('/leads'), ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (cursor) return HttpResponse.json({ items: [makeLead({ name: 'Tail Lead' })] });
        return HttpResponse.json({ items: pageOne, nextCursor: 'page-2' });
      }),
    );

    renderAt('/leads?q=lead');
    await screen.findByText('Lead 001');
    expect(await screen.findByText(/loaded leads — scroll to load the rest/)).toBeInTheDocument();
  });

  // failure path: a fully-loaded list must NOT carry the partial disclaimer
  test('no partial-scope note once every page is loaded', async () => {
    useReferenceHandlers();
    server.use(
      http.get(api('/leads'), () => HttpResponse.json({ items: [makeLead({ name: 'Only One' })] })),
    );
    renderAt('/leads?q=only');
    await screen.findByText('Only One');
    expect(screen.queryByText(/loaded leads — scroll/)).toBeNull();
  });
});

describe('LeadsSurface — filter, selection, reduced motion', () => {
  test('the filter narrows loaded rows and can be cleared', async () => {
    useReferenceHandlers();
    const leads = [
      makeLead({ name: 'Alpha Corp' }),
      makeLead({ name: 'Bravo Corp' }),
      makeLead({ name: 'Alpha Two' }),
    ];
    server.use(http.get(api('/leads'), () => HttpResponse.json({ items: leads })));
    renderAt('/leads');

    await screen.findByText('Alpha Corp');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter these leads' }), 'Alpha');

    await waitFor(() => expect(screen.queryByText('Bravo Corp')).toBeNull());
    expect(screen.getByText('Alpha Corp')).toBeInTheDocument();
    expect(screen.getByText('Alpha Two')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(await screen.findByText('Bravo Corp')).toBeInTheDocument();
  });

  test('selecting rows reveals the bulk bar with the live LeadBulkActions', async () => {
    useReferenceHandlers();
    server.use(http.get(api('/sequences'), () => HttpResponse.json([])));
    const leads = [makeLead({ name: 'North Labs' }), makeLead({ name: 'Cedar Systems' })];
    server.use(http.get(api('/leads'), () => HttpResponse.json({ items: leads })));
    renderAt('/leads');

    const firstRow = (await screen.findAllByRole('row'))[1]!;
    await userEvent.click(within(firstRow).getByRole('checkbox'));

    const bulk = screen.getByRole('region', { name: /1 leads selected/ });
    expect(bulk).toBeInTheDocument();
    // The Phase-4 disabled placeholders are gone; the admin feature's live bulk
    // actions render instead — real, enabled controls that mutate through C7.
    expect(within(bulk).queryByRole('button', { name: /Add to sequence/ })).toBeNull();
    // findBy: LeadBulkActions is a lazy boundary now (audit #6) — the live
    // actions hydrate a tick after the bar appears.
    expect(await within(bulk).findByRole('button', { name: /Export CSV/ })).toBeEnabled();
    expect(within(bulk).getByRole('button', { name: /Enroll in sequence/ })).toBeInTheDocument();

    await userEvent.click(within(bulk).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('region', { name: /selected/ })).toBeNull();
  });

  test('honors prefers-reduced-motion', async () => {
    useReferenceHandlers();
    server.use(http.get(api('/leads'), () => HttpResponse.json({ items: [makeLead()] })));

    const saved = window.matchMedia;
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: query.includes('reduce'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList;
    try {
      const { container } = renderAt('/leads');
      await screen.findByRole('grid');
      expect(container.querySelector('.leads-surface')).toHaveAttribute(
        'data-reduced-motion',
        'true',
      );
    } finally {
      window.matchMedia = saved;
    }
  });
});
