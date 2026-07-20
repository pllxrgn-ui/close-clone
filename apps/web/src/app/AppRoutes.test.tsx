import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { db } from '../mocks/fixtures.ts';
import { renderRoutes } from '../test/renderRoutes.tsx';

const [USER] = db.users;
if (!USER) throw new Error('fixtures must include at least one user');

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('app shell + routing (authenticated)', () => {
  test('renders the shell chrome and the Inbox landing', async () => {
    renderRoutes('/inbox', { user: USER });
    expect(await screen.findByRole('heading', { name: 'Inbox', level: 1 })).toBeInTheDocument();
    // slim top bar (banner) + keyboardable rail + global search. The real Inbox
    // page renders its own <header> inside <main> — not a landmark per ARIA (axe
    // agrees), but getByRole over-counts it as a second "banner", so assert the
    // shell's top-bar banner specifically rather than assuming a single one.
    expect(screen.getAllByRole('banner').some((el) => el.classList.contains('sb-topbar'))).toBe(
      true,
    );
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Global search' })).toBeInTheDocument();
    // user chip shows the signed-in user (name appears in the chip + its menu)
    expect(screen.getAllByText(USER.name).length).toBeGreaterThan(0);
  });

  test('the index route redirects to /overview', async () => {
    renderRoutes('/', { user: USER });
    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeInTheDocument();
  });

  test('clicking a rail link navigates and marks aria-current', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    const leadsLink = screen.getByRole('link', { name: /Leads/ });
    await userEvent.click(leadsLink);

    // The Inbox landing now fetches (React Query) before this navigates away, so
    // under full-suite parallel load the lazy Leads chunk can render just past the
    // 1s findBy default. Give it real headroom — measured 3.95s under a full
    // parallel run, so 4s sat on the cliff. The app itself navigates instantly.
    expect(
      await screen.findByRole('heading', { name: 'All leads', level: 1 }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(leadsLink).toHaveAttribute('aria-current', 'page');
  });

  test('the "g" then "l" chord jumps to Leads', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    await userEvent.keyboard('gl');

    // Headroom for the lazy Leads chunk under parallel load (see the rail-link test).
    expect(
      await screen.findByRole('heading', { name: 'All leads', level: 1 }, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  test('"/" focuses the global search input', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    const search = screen.getByRole('searchbox', { name: 'Global search' });
    expect(search).not.toHaveFocus();
    await userEvent.keyboard('/');
    expect(search).toHaveFocus();
  });

  test('a lead-detail route reflects its :id param', async () => {
    renderRoutes('/leads/abc-123', { user: USER });
    expect(await screen.findByText('Lead not found')).toBeInTheDocument();
  });

  test('an unknown authenticated route renders 404 within the shell', async () => {
    renderRoutes('/does-not-exist', { user: USER });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    // chrome is still present
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });

  // failure path: the guard redirects an unauthenticated visitor to login
  test('an unauthenticated visit to a protected route redirects to login', async () => {
    renderRoutes('/leads');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('dev-login flow', () => {
  test('picking a user signs in and lands on the requested route', async () => {
    renderRoutes('/reports');
    // guard bounced us to login
    await screen.findByRole('heading', { name: 'Sign in' });
    const pick = await screen.findByRole('button', { name: new RegExp(USER.name) });
    await userEvent.click(pick);
    // returned to the originally requested page
    expect(await screen.findByRole('heading', { name: 'Reports', level: 1 })).toBeInTheDocument();
  });
});
