import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { db } from '../mocks/fixtures.ts';
import { renderRoutes } from '../test/renderRoutes.tsx';

const [USER] = db.users;
if (!USER) throw new Error('fixtures must include at least one user');

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('keyboard layer wired into the shell', () => {
  test('Cmd/Ctrl+K opens the command palette', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    await userEvent.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  test('the top-bar Command button opens the palette', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    await userEvent.click(screen.getByRole('button', { name: 'Open command palette' }));
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  test('? opens the cheat sheet, which reflects the registered bindings', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    await userEvent.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    // a global binding and a route chord, straight from the registry
    expect(within(dialog).getByText('Command palette')).toBeInTheDocument();
    expect(within(dialog).getByText('Go to Leads')).toBeInTheDocument();
  });

  test('Escape closes the palette', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    await userEvent.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });

  test('the Views demo list has a working roving tabindex (useListNav)', async () => {
    renderRoutes('/views', { user: USER });
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]).toHaveAttribute('tabindex', '0');
    expect(options[1]).toHaveAttribute('tabindex', '-1');

    act(() => options[0]?.focus());
    expect(options[0]).toHaveFocus();
    await userEvent.keyboard('j');
    expect(options[1]).toHaveFocus();
    expect(options[1]).toHaveAttribute('tabindex', '0');
    expect(options[0]).toHaveAttribute('tabindex', '-1');
  });

  test('the open palette passes an axe smoke test inside the shell', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });
    await userEvent.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command palette' });

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    const summary = blocking.map((v) => `${v.id}: ${v.help}`).join('\n');
    expect(summary).toBe('');
  });

  test('the g-then-l chord still navigates (registry-driven)', async () => {
    renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });
    await userEvent.keyboard('gl');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'All leads', level: 1 })).toBeInTheDocument(),
    );
  });
});
