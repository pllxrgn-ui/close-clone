import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../feedback/index.ts';
import { ROUTER_FUTURE } from '../../app/routerFuture.ts';
import { CommsProvider } from './context/CommsProvider.tsx';
import { useCommsCommands } from './commands.ts';

/*
 * The palette command registrations. Renders the hook's commands as buttons and
 * verifies the three surface commands exist and that "Email lead…" opens the
 * composer via CommsProvider (the wiring the palette performs at merge).
 */

function CommandHarness(): JSX.Element {
  const commands = useCommsCommands(() => {});
  return (
    <ul>
      {commands.map((c) => (
        <li key={c.id}>
          <button onClick={c.run}>{c.title}</button>
        </li>
      ))}
    </ul>
  );
}

afterEach(cleanup);

test('registers the comms commands; Email lead opens the composer', async () => {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter future={ROUTER_FUTURE}>
          <CommsProvider>
            <CommandHarness />
          </CommsProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

  expect(screen.getByRole('button', { name: 'Email lead…' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open sequences' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enroll in sequence…' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Email lead…' }));
  expect(await screen.findByRole('dialog', { name: 'New email' })).toBeInTheDocument();
});
