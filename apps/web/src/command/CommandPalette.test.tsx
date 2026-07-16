import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import * as axe from 'axe-core';
import { ThemeProvider } from '../theme/ThemeProvider.tsx';
import { ToastProvider } from '../feedback/ToastProvider.tsx';
import { ROUTER_FUTURE } from '../app/routerFuture.ts';
import { db } from '../mocks/fixtures.ts';
import { CommsProvider } from '../features/comms/index.ts';
import { CommandPalette } from './CommandPalette.tsx';

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function LocationDisplay(): ReactNode {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
}

function Harness({
  startOpen = true,
  initialPath = '/start',
}: {
  startOpen?: boolean;
  initialPath?: string;
}): ReactNode {
  const [client] = useState(makeClient);
  const [open, setOpen] = useState(startOpen);
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialPath]} future={ROUTER_FUTURE}>
          <ToastProvider>
            <CommsProvider>
              <button type="button" onClick={() => setOpen(true)}>
                open palette
              </button>
              <CommandPalette open={open} onClose={() => setOpen(false)} />
              <LocationDisplay />
            </CommsProvider>
          </ToastProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(cleanup);

describe('CommandPalette', () => {
  test('opens as a labelled dialog with the combobox focused', async () => {
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const combobox = screen.getByRole('combobox', { name: 'Command palette' });
    expect(combobox).toHaveFocus();
    expect(combobox).toHaveAttribute('aria-controls');
  });

  test('fuzzy-filters commands as you type', async () => {
    render(<Harness />);
    const combobox = await screen.findByRole('combobox');
    await userEvent.type(combobox, 'settings');
    expect(screen.getByRole('option', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Inbox' })).not.toBeInTheDocument();
  });

  test('Enter runs the active command (navigate)', async () => {
    render(<Harness />);
    const combobox = await screen.findByRole('combobox');
    await userEvent.type(combobox, 'inbox');
    await screen.findByRole('option', { name: 'Inbox' });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/inbox'));
  });

  test('arrow keys move the active option (aria-activedescendant)', async () => {
    render(<Harness />);
    const combobox = await screen.findByRole('combobox');
    await userEvent.click(combobox);
    const first = combobox.getAttribute('aria-activedescendant');
    expect(first).toBeTruthy();
    expect(document.getElementById(first ?? '')).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowDown}');
    const second = combobox.getAttribute('aria-activedescendant');
    expect(second).not.toBe(first);
    expect(document.getElementById(second ?? '')).toHaveAttribute('aria-selected', 'true');
  });

  test('action commands toast the Phase-4 placeholder', async () => {
    render(<Harness />);
    const combobox = await screen.findByRole('combobox');
    await userEvent.type(combobox, 'log call');
    await screen.findByRole('option', { name: 'Log call' });
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Log call — wired in Phase 4')).toBeInTheDocument();
  });

  test('the theme command toggles the theme and closes', async () => {
    render(<Harness />);
    const combobox = await screen.findByRole('combobox');
    await userEvent.type(combobox, 'theme');
    await userEvent.click(screen.getByRole('option', { name: 'Toggle theme' }));
    // system → light stamps the attribute
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });

  test('searches leads via the API client and opens the lead on select', async () => {
    const counts = new Map<string, number>();
    for (const lead of db.leads) counts.set(lead.name, (counts.get(lead.name) ?? 0) + 1);
    const lead = db.leads.find((l) => counts.get(l.name) === 1) ?? db.leads[0];
    if (!lead) throw new Error('fixtures must include leads');

    render(<Harness />);
    const combobox = await screen.findByRole('combobox');
    await userEvent.type(combobox, lead.name);

    const option = await screen.findByRole('option', { name: lead.name });
    await userEvent.click(option);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(`/leads/${lead.id}`));
  });

  test('restores focus to the opener when closed with Escape', async () => {
    render(<Harness startOpen={false} />);
    const opener = screen.getByRole('button', { name: 'open palette' });
    opener.focus();
    await userEvent.click(opener);

    const combobox = await screen.findByRole('combobox');
    expect(combobox).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  test('has no serious/critical axe violations when open', async () => {
    render(<Harness />);
    await screen.findByRole('combobox');
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    const summary = blocking.map((v) => `${v.id}: ${v.help}`).join('\n');
    expect(summary).toBe('');
  });
});
