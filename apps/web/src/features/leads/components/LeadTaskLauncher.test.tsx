import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { AuthProvider } from '../../../auth/AuthProvider.tsx';
import { ToastProvider } from '../../../feedback/ToastProvider.tsx';
import { LeadTaskLauncher } from './LeadTaskLauncher.tsx';

const api = (p: string): string => `*/api/v1${p}`;

function Harness({ children }: { children: ReactNode }): ReactNode {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

const LEAD = db.leads.find((l) => l.deletedAt === null);
if (!LEAD) throw new Error('fixtures must include a live lead');

afterEach(cleanup);

describe('LeadTaskLauncher', () => {
  test('opens the modal; Create stays disabled until a title exists', async () => {
    render(
      <Harness>
        <LeadTaskLauncher lead={LEAD} />
      </Harness>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Task/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    const create = screen.getByRole('button', { name: 'Create task' });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Title/), 'Send the revised quote');
    expect(create).toBeEnabled();
  });

  test('creating posts through the real C7 route, toasts, and closes', async () => {
    render(
      <Harness>
        <LeadTaskLauncher lead={LEAD} />
      </Harness>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Task/ }));
    await userEvent.type(await screen.findByLabelText(/Title/), 'Book the technical review');
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));

    expect(await screen.findByText(/Task created — Book the technical review/)).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('due-date presets fill the date field with the matching local day', async () => {
    render(
      <Harness>
        <LeadTaskLauncher lead={LEAD} />
      </Harness>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Task/ }));
    await screen.findByRole('dialog');

    const expected = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${dd}`;
    })();
    await userEvent.click(screen.getByRole('button', { name: 'Tomorrow' }));
    expect(screen.getByLabelText('Due date')).toHaveValue(expected);
    expect(screen.getByRole('button', { name: 'Tomorrow' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Presets alone never enable Create — a title is still required.
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
  });

  test('a failed create surfaces the API error and keeps the modal open', async () => {
    server.use(
      http.post(api('/tasks'), () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'Task service unavailable' } },
          { status: 500 },
        ),
      ),
    );
    render(
      <Harness>
        <LeadTaskLauncher lead={LEAD} />
      </Harness>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Task/ }));
    await userEvent.type(await screen.findByLabelText(/Title/), 'Doomed task');
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));

    expect(await screen.findByText(/Task service unavailable/)).toBeVisible();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
