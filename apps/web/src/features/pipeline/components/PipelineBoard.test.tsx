import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import type { Opportunity, OpportunityStage } from '@switchboard/shared';
import { KeyboardProvider } from '../../../keyboard/index.ts';
import { server } from '../../../mocks/server.ts';
import { resetStore } from '../data/store.ts';
import { pipelineHandlers } from '../mocks/pipelineHandlers.ts';
import { COLUMN_RENDER_CAP, PipelineBoard } from './PipelineBoard.tsx';

const api = (p: string): string => `*/api/v1${p}`;

function mkStage(id: string, label: string, sortOrder: number): OpportunityStage {
  return {
    id,
    label,
    sortOrder,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
function mkOpp(
  id: string,
  leadId: string,
  stageId: string,
  currency: string,
  valueCents: number,
  confidence: number,
  closeDate: string,
): Opportunity {
  return {
    id,
    leadId,
    contactId: null,
    valueCents,
    currency,
    stageId,
    confidence,
    closeDate,
    ownerId: 'u1',
    status: 'active',
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const STAGES: OpportunityStage[] = [
  mkStage('s-disc', 'Discovery', 0),
  mkStage('s-prop', 'Proposal', 1),
  mkStage('s-neg', 'Negotiation', 2),
  mkStage('s-won', 'Closed Won', 3),
  mkStage('s-lost', 'Closed Lost', 4),
];

// Discovery mixes USD + EUR (currency separation); Proposal has USD; Negotiation
// has a past-due AUD deal (amber). Closed Won/Lost start empty (drop hints).
const OPPS: Opportunity[] = [
  mkOpp('o1', 'l1', 's-disc', 'USD', 100_000_00, 40, '2026-09-01'),
  mkOpp('o2', 'l2', 's-disc', 'EUR', 200_000_00, 50, '2026-09-01'),
  mkOpp('o3', 'l3', 's-prop', 'USD', 50_000_00, 30, '2026-09-01'),
  mkOpp('o4', 'l4', 's-neg', 'AUD', 80_000_00, 60, '2026-06-01'),
];

const LEADS = [
  { id: 'l1', name: 'Acme Robotics' },
  { id: 'l2', name: 'Globex Manufaktur' },
  { id: 'l3', name: 'Initech Systems' },
  { id: 'l4', name: 'Umbrella Freight' },
];
const USERS = [{ id: 'u1', name: 'Dana Owner', email: 'dana@x.test', isActive: true }];

function renderBoard(
  client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      <KeyboardProvider>
        <MemoryRouter initialEntries={['/pipeline']}>
          <Routes>
            <Route path="/pipeline" element={<PipelineBoard />} />
            <Route path="/leads/:id" element={<div data-testid="lead-detail" />} />
          </Routes>
        </MemoryRouter>
      </KeyboardProvider>
    </QueryClientProvider>,
  );
}

const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };
async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, AXE_OPTIONS);
  expect(results.passes.length).toBeGreaterThan(0);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(blocking.map((v) => `${v.id}: ${v.help}`).join('\n')).toBe('');
}

const card = (name: RegExp): HTMLElement => screen.getByRole('listitem', { name });
const column = (name: RegExp): HTMLElement => screen.getByRole('region', { name });
/** The per-currency subtotal figures in a column header (not the card values). */
const colSums = (name: RegExp): HTMLElement => {
  const el = column(name).querySelector('.pl-col__sums');
  if (!(el instanceof HTMLElement)) throw new Error(`no sums element in column ${String(name)}`);
  return el;
};

beforeAll(() => {
  document.documentElement.lang = 'en';
  document.title = 'Switchboard';
});
beforeEach(() => {
  resetStore({ opportunities: OPPS, stages: STAGES });
  server.use(
    ...pipelineHandlers,
    http.get(api('/leads'), () => HttpResponse.json({ items: LEADS })),
    http.get(api('/users'), () => HttpResponse.json(USERS)),
  );
});
afterEach(() => {
  cleanup();
  resetStore();
  document.documentElement.removeAttribute('data-theme');
});

describe('PipelineBoard — render', () => {
  test('renders a column per stage with its cards and totals', async () => {
    renderBoard();
    expect(await screen.findByRole('heading', { name: 'Pipeline', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: /Acme Robotics/ })).toBeInTheDocument();
    expect(card(/Globex Manufaktur/)).toBeInTheDocument();
    // Five stage columns.
    expect(screen.getAllByRole('region')).toHaveLength(5);
  });

  test('empty terminal columns show a quiet drop hint, not blank space', async () => {
    renderBoard();
    await screen.findByRole('listitem', { name: /Acme Robotics/ });
    expect(within(column(/Closed Lost/)).getByText('Drop a deal here')).toBeInTheDocument();
  });

  test('a past-due close date is marked overdue (amber)', async () => {
    renderBoard();
    const overdue = await screen.findByRole('listitem', { name: /Umbrella Freight/ });
    expect(overdue.querySelector('.pl-card__date.is-overdue')).not.toBeNull();
  });
});

describe('PipelineBoard — lead-name resolution (caching)', () => {
  // The lead-name join drains every page of GET /leads to label cards. That
  // drain is ~25 serial round-trips at 5k leads; with default query freshness it
  // re-ran on EVERY board mount (and window focus). It must run once per session
  // and then serve from cache — otherwise the board's biggest network cost repeats
  // on every navigation back to it.
  test('resolves lead names once and serves the rest from cache across remounts', async () => {
    let leadsCalls = 0;
    server.use(
      ...pipelineHandlers,
      http.get(api('/leads'), () => {
        leadsCalls += 1;
        return HttpResponse.json({ items: LEADS });
      }),
      http.get(api('/users'), () => HttpResponse.json(USERS)),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { unmount } = renderBoard(client);
    await screen.findByRole('listitem', { name: /Acme Robotics/ });
    expect(leadsCalls).toBe(1);

    unmount();

    renderBoard(client);
    // Names render immediately from cache — no second drain on remount.
    expect(await screen.findByRole('listitem', { name: /Acme Robotics/ })).toBeInTheDocument();
    expect(leadsCalls).toBe(1);
  });
});

describe('PipelineBoard — move network discipline (audit #2)', () => {
  // A keyboard move must NOT re-drain the board: the optimistic write plus the
  // server's confirmed row are the source of truth. Re-fetching every deal per
  // keystroke is the board's hottest path × its heaviest query.
  test('a move PATCHes once and never refetches the opportunity list', async () => {
    let oppsGets = 0;
    let patches = 0;
    // Pass-through counters: prepended above the runtime handlers, they count
    // and return undefined so the real store handlers still serve the data.
    server.use(
      http.get(api('/opportunities'), () => {
        oppsGets += 1;
        return undefined;
      }),
      http.patch(api('/opportunities/:id'), () => {
        patches += 1;
        return undefined;
      }),
    );

    renderBoard();
    await userEvent.click(await screen.findByRole('listitem', { name: /Acme Robotics/ }));
    const afterLoad = oppsGets;

    fireEvent.keyDown(card(/Acme Robotics/), { key: ']' });
    await within(column(/Proposal/)).findByRole('listitem', { name: /Acme Robotics/ });
    await waitFor(() => expect(patches).toBe(1));

    // Give any (incorrect) onSettled invalidation a chance to fire, then assert
    // the list was never re-fetched.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(oppsGets).toBe(afterLoad);
  });
});

describe('PipelineBoard — currency separation', () => {
  test('a mixed-currency column reports each currency separately, never summed', async () => {
    renderBoard();
    await screen.findByRole('listitem', { name: /Acme Robotics/ });
    // Discovery's header subtotal shows both currencies as separate figures.
    expect(within(colSums(/Discovery/)).getByText('$100K')).toBeInTheDocument();
    expect(within(colSums(/Discovery/)).getByText('€200K')).toBeInTheDocument();
    // The board header keeps them apart too.
    const openPipeline = screen.getByText('Open pipeline').closest('.pl-metric');
    expect(openPipeline).not.toBeNull();
    expect(within(openPipeline as HTMLElement).getByText('A$80K')).toBeInTheDocument();
  });
});

describe('PipelineBoard — keyboard move (drag alternative)', () => {
  test('] moves the focused deal to the next stage and recomputes both column sums', async () => {
    renderBoard();
    await userEvent.click(await screen.findByRole('listitem', { name: /Acme Robotics/ }));
    fireEvent.keyDown(card(/Acme Robotics/), { key: ']' });

    // The card now lives in Proposal.
    await within(column(/Proposal/)).findByRole('listitem', { name: /Acme Robotics/ });

    // Discovery lost its USD subtotal; Proposal now totals $150K ($100K + $50K).
    await waitFor(() => expect(within(colSums(/Discovery/)).queryByText('$100K')).toBeNull());
    expect(within(colSums(/Discovery/)).getByText('€200K')).toBeInTheDocument();
    expect(within(colSums(/Proposal/)).getByText('$150K')).toBeInTheDocument();
  });

  test('[ moves the focused deal back a stage', async () => {
    renderBoard();
    await userEvent.click(await screen.findByRole('listitem', { name: /Initech Systems/ }));
    fireEvent.keyDown(card(/Initech Systems/), { key: '[' });
    await within(column(/Discovery/)).findByRole('listitem', { name: /Initech Systems/ });
  });

  test('the move persists across a remount (writes survive route changes)', async () => {
    const { unmount } = renderBoard();
    await userEvent.click(await screen.findByRole('listitem', { name: /Acme Robotics/ }));
    fireEvent.keyDown(card(/Acme Robotics/), { key: ']' });
    await within(column(/Proposal/)).findByRole('listitem', { name: /Acme Robotics/ });

    unmount();
    renderBoard();
    // Re-fetched from the store, the deal is still in Proposal.
    await within(await screen.findByRole('region', { name: /Proposal/ })).findByRole('listitem', {
      name: /Acme Robotics/,
    });
  });
});

describe('PipelineBoard — won / lost', () => {
  test('W marks the focused deal won: it lands in Closed Won and leaves open pipeline', async () => {
    renderBoard();
    await screen.findByRole('listitem', { name: /Umbrella Freight/ });
    // AUD is in open pipeline before the win.
    const openBefore = screen.getByText('Open pipeline').closest('.pl-metric') as HTMLElement;
    expect(within(openBefore).getByText('A$80K')).toBeInTheDocument();

    await userEvent.click(card(/Umbrella Freight/));
    fireEvent.keyDown(card(/Umbrella Freight/), { key: 'w' });

    const wonCard = await within(column(/Closed Won/)).findByRole('listitem', {
      name: /Umbrella Freight/,
    });
    expect(within(wonCard).getByText('Won')).toBeInTheDocument();
    expect(wonCard).toHaveClass('pl-card--flash-won');

    // Won money is realized, so it drops out of the open-pipeline figure.
    await waitFor(() => {
      const openAfter = screen.getByText('Open pipeline').closest('.pl-metric') as HTMLElement;
      expect(within(openAfter).queryByText('A$80K')).toBeNull();
    });
  });

  test('L marks the focused deal lost', async () => {
    renderBoard();
    await userEvent.click(await screen.findByRole('listitem', { name: /Initech Systems/ }));
    fireEvent.keyDown(card(/Initech Systems/), { key: 'l' });
    const lostCard = await within(column(/Closed Lost/)).findByRole('listitem', {
      name: /Initech Systems/,
    });
    expect(within(lostCard).getByText('Lost')).toBeInTheDocument();
  });
});

describe('PipelineBoard — bounded rendering (large real datasets)', () => {
  /** N deals in Discovery with strictly descending values, plus their leads. */
  function crowd(n: number): {
    opps: Opportunity[];
    leads: Array<{ id: string; name: string }>;
  } {
    const opps: Opportunity[] = [];
    const leads: Array<{ id: string; name: string }> = [];
    for (let i = 1; i <= n; i += 1) {
      const tag = String(i).padStart(3, '0');
      opps.push(
        mkOpp(`c${tag}`, `cl${tag}`, 's-disc', 'USD', (n - i + 1) * 1_000_00, 50, '2026-09-01'),
      );
      leads.push({ id: `cl${tag}`, name: `Crowd ${tag}` });
    }
    return { opps, leads };
  }

  function seedCrowd(
    extraOpps: Opportunity[] = [],
    extraLeads: Array<{ id: string; name: string }> = [],
  ) {
    const { opps, leads } = crowd(COLUMN_RENDER_CAP + 5);
    resetStore({ opportunities: [...opps, ...extraOpps], stages: STAGES });
    server.use(
      ...pipelineHandlers,
      http.get(api('/leads'), () => HttpResponse.json({ items: [...leads, ...extraLeads] })),
      http.get(api('/users'), () => HttpResponse.json(USERS)),
    );
  }

  test('a column past the cap renders only the top cards plus a Show-all control; count and sums stay true', async () => {
    seedCrowd();
    renderBoard();
    await screen.findByRole('listitem', { name: /Crowd 001/ });
    const disc = column(/Discovery/);
    // DOM bounded to the cap…
    expect(within(disc).getAllByRole('listitem')).toHaveLength(COLUMN_RENDER_CAP);
    // …but the column still reports the TRUE deal count (money math is full-data).
    expect(disc).toHaveAccessibleName(new RegExp(`${COLUMN_RENDER_CAP + 5} deals`));
    // Show-all reveals the rest of the column.
    await userEvent.click(
      within(disc).getByRole('button', {
        name: `Show all ${COLUMN_RENDER_CAP + 5} deals in Discovery`,
      }),
    );
    expect(within(disc).getAllByRole('listitem')).toHaveLength(COLUMN_RENDER_CAP + 5);
    expect(within(disc).queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  // failure path: a column at or under the cap must not grow an expander
  test('a column within the cap renders fully with no Show-all control', async () => {
    renderBoard(); // default 4-deal fixture from beforeEach
    await screen.findByRole('listitem', { name: /Acme Robotics/ });
    expect(within(column(/Discovery/)).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  // CONTRACTS 1.3.3: names resolve via GET /leads?ids= for RENDERED cards only;
  // expanding a column fetches exactly the newly revealed ids, once.
  test('name resolution requests only rendered leadIds; expanding fetches the delta', async () => {
    const { opps, leads } = crowd(COLUMN_RENDER_CAP + 5);
    resetStore({ opportunities: [...opps], stages: STAGES });
    const urls: string[] = [];
    server.use(
      ...pipelineHandlers,
      http.get(api('/leads'), ({ request }) => {
        urls.push(request.url);
        // Honor the ids filter like the real route — otherwise every name
        // resolves on batch one and there is no delta left to observe.
        const wanted = new Set(
          (new URL(request.url).searchParams.get('ids') ?? '').split(',').filter(Boolean),
        );
        return HttpResponse.json({ items: leads.filter((l) => wanted.has(l.id)) });
      }),
      http.get(api('/users'), () => HttpResponse.json(USERS)),
    );
    const idsOf = (url: string): string[] =>
      (new URL(url).searchParams.get('ids') ?? '').split(',').filter(Boolean);

    renderBoard();
    await screen.findByRole('listitem', { name: /Crowd 001/ });
    expect(urls).toHaveLength(1);
    expect(idsOf(urls[0] ?? '')).toHaveLength(COLUMN_RENDER_CAP);

    await userEvent.click(
      screen.getByRole('button', {
        name: `Show all ${COLUMN_RENDER_CAP + 5} deals in Discovery`,
      }),
    );
    await screen.findByRole('listitem', { name: /Crowd 035/ });
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(idsOf(urls[1] ?? '')).toHaveLength(5);
  });

  test('a keyboard move into a crowded column keeps the moved card rendered and focused', async () => {
    // Tiny deal in Proposal sorts dead-last in Discovery after the move.
    const tinyOpp = mkOpp('tiny', 'l-tiny', 's-prop', 'USD', 1, 10, '2026-09-01');
    seedCrowd([tinyOpp], [{ id: 'l-tiny', name: 'Tiny Deal Co' }]);
    renderBoard();
    await userEvent.click(await screen.findByRole('listitem', { name: /Tiny Deal Co/ }));
    fireEvent.keyDown(card(/Tiny Deal Co/), { key: '[' });

    const moved = await within(column(/Discovery/)).findByRole('listitem', {
      name: /Tiny Deal Co/,
    });
    // Pinned past the cap: cap-worth of top cards + the active card.
    expect(within(column(/Discovery/)).getAllByRole('listitem')).toHaveLength(
      COLUMN_RENDER_CAP + 1,
    );
    await waitFor(() => expect(moved).toHaveFocus());
  });
});

describe('PipelineBoard — error + accessibility', () => {
  test('a failed opportunities fetch shows a typed error with retry', async () => {
    server.use(
      http.get(api('/opportunities'), () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderBoard();
    expect(await screen.findByText('Couldn’t load the pipeline')).toBeInTheDocument();
    expect(screen.getByText(/INTERNAL/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  test('no serious axe violations in either theme', async () => {
    const { container } = renderBoard();
    await screen.findByRole('listitem', { name: /Acme Robotics/ });

    document.documentElement.dataset.theme = 'dark';
    await expectNoSeriousViolations(container);
    document.documentElement.dataset.theme = 'light';
    await expectNoSeriousViolations(container);
  });
});
