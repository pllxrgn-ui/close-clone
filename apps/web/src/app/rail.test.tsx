import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { db } from '../mocks/fixtures.ts';
import { renderRoutes } from '../test/renderRoutes.tsx';
import { RAIL_STORAGE_KEY } from './railState.ts';

const [USER] = db.users;
if (!USER) throw new Error('fixtures must include at least one user');

const rail = (): HTMLElement => screen.getByRole('navigation', { name: 'Primary' });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('LeftRail — structure', () => {
  test('work surfaces sit above the tool group; Support & FAQs then Settings, collapse last', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    const labels = [...rail().querySelectorAll('.sb-rail__item .sb-rail__label')].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      'Inbox',
      'Leads',
      'Pipeline',
      'Views',
      'Reports',
      'Import',
      'Support & FAQs',
      'Settings',
    ]);

    // The collapse control is the rail's last focusable thing (DOM order is
    // what Tab follows).
    const focusables = [...rail().querySelectorAll('a, button')];
    expect(focusables[focusables.length - 1]).toHaveAccessibleName('Collapse sidebar');

    // Support & FAQs + Settings live in the pinned foot, not the work list.
    const foot = rail().querySelector('.sb-rail__foot');
    expect(within(foot as HTMLElement).getByRole('link', { name: /Settings/ })).toBeInTheDocument();
    expect(
      within(foot as HTMLElement).getByRole('link', { name: /Support & FAQs/ }),
    ).toBeInTheDocument();
  });

  test('Support & FAQs routes to the real help page (no dead link)', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    await userEvent.click(within(rail()).getByRole('link', { name: /Support & FAQs/ }));
    // Lazy route: the help chunk can take >1s under full-suite CPU contention,
    // so this navigation assertion gets a real timeout (flaked twice at 1s).
    expect(
      await screen.findByRole('heading', { name: 'Support & FAQs', level: 1 }, { timeout: 5000 }),
    ).toBeVisible();
    // Real answers, not placeholder copy.
    expect(screen.getByText(/do not contact/i)).toBeInTheDocument();
  });
});

describe('LeftRail — collapse', () => {
  test('collapsing hides the labels, keeps the links named, and persists', async () => {
    const { unmount } = renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    const inbox = within(rail()).getByRole('link', { name: /Inbox/ });
    expect(inbox).toHaveTextContent('Inbox');

    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    // Label text is gone, but the link still names itself for screen readers.
    const collapsedInbox = within(rail()).getByRole('link', { name: 'Inbox' });
    expect(collapsedInbox).toHaveTextContent('');
    expect(localStorage.getItem(RAIL_STORAGE_KEY)).toBe('collapsed');

    // The control now offers the way back.
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // Preference survives a remount.
    unmount();
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  test('expanding restores the labels and clears the stored preference', async () => {
    localStorage.setItem(RAIL_STORAGE_KEY, 'collapsed');
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    await userEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));

    expect(within(rail()).getByRole('link', { name: /Inbox/ })).toHaveTextContent('Inbox');
    expect(localStorage.getItem(RAIL_STORAGE_KEY)).toBeNull();
  });

  test('a collapsed rail has no serious/critical axe violations', async () => {
    localStorage.setItem(RAIL_STORAGE_KEY, 'collapsed');
    const { container } = renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.passes.length).toBeGreaterThan(0);
    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(blocking.map((v) => `${v.id}: ${v.help}`).join('\n')).toBe('');
  });
});
