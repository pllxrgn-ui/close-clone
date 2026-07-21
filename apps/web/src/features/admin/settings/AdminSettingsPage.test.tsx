import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../../feedback/ToastProvider.tsx';
import { AuthProvider } from '../../../auth/AuthProvider.tsx';
import { browserNav } from '../../../auth/browserNav.ts';
import { storeUser } from '../../../auth/auth.ts';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { adminHandlers } from '../mocks/adminHandlers.ts';
import { adminStore, resetAdminStore } from '../mocks/adminStore.ts';
import { disconnectEmailAccount } from '../api.ts';
import { AdminSettingsPage } from './AdminSettingsPage.tsx';

/*
 * Settings surface: sub-rail navigation between sections, plus the write flows —
 * create custom field, edit a template body in the drawer, and edit the daily
 * send cap — each hitting the real admin handlers so the store is the store under
 * test.
 */

function renderSettings(section?: string, role: 'admin' | 'rep' = 'admin'): void {
  const signedInUser = db.users.find((candidate) => candidate.role === role);
  if (!signedInUser) throw new Error(`Missing ${role} fixture`);
  storeUser(signedInUser);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <ToastProvider ttl={0}>
          <MemoryRouter initialEntries={[`/settings${section ? `?section=${section}` : ''}`]}>
            <AdminSettingsPage />
          </MemoryRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetAdminStore();
  server.use(...adminHandlers);
});
afterEach(() => {
  cleanup();
});

describe('navigation', () => {
  test('opens personal inbox settings by default', async () => {
    renderSettings();
    await screen.findByRole('heading', { name: 'Inboxes', level: 1 });
  });

  test('renders Users by default and switches sections via the sub-rail', async () => {
    const user = userEvent.setup();
    renderSettings('users');

    await screen.findByRole('heading', { name: 'Users', level: 1 });
    expect(await screen.findByText('Ada Okafor')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Compliance' }));
    await screen.findByRole('heading', { name: 'Compliance', level: 1 });

    await user.click(screen.getByRole('link', { name: 'About' }));
    await screen.findByRole('heading', { name: 'About Switchboard', level: 1 });
    expect(screen.getByRole('link', { name: /Open the product tour/ })).toHaveAttribute(
      'href',
      '/welcome',
    );
  });

  test('keeps organization settings hidden from reps', async () => {
    renderSettings(undefined, 'rep');
    await screen.findByRole('heading', { name: 'Inboxes', level: 1 });
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Compliance' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'About' })).toBeInTheDocument();
  });
});

describe('inboxes', () => {
  test('connects and disconnects a Gmail account through the mock API', async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(browserNav, 'assign').mockImplementation(() => undefined);
    renderSettings('inboxes');

    await user.clear(await screen.findByLabelText(/Gmail address/));
    await user.type(screen.getByLabelText(/Gmail address/), 'seller@example.com');
    await user.click(screen.getByRole('button', { name: 'Connect Gmail' }));

    await screen.findByText('seller@example.com');
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(adminStore.emailAccounts).toHaveLength(1);
    expect(adminStore.emailAccounts[0]?.address).toBe('seller@example.com');

    await user.click(await screen.findByRole('button', { name: 'Disconnect seller@example.com' }));
    expect(await screen.findByText('Needs reconnect')).toBeInTheDocument();
    expect(adminStore.emailAccounts[0]?.syncStatus).toBe('REAUTH_REQUIRED');

    await user.click(screen.getByRole('button', { name: 'Reconnect Gmail' }));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(adminStore.emailAccounts[0]?.syncStatus).toBe('LIVE');
  });

  test('keeps the mock inbox flow scoped to the signed-in rep', async () => {
    const admin = db.users.find((candidate) => candidate.role === 'admin');
    const rep = db.users.find((candidate) => candidate.role === 'rep');
    if (!admin || !rep) throw new Error('Missing admin or rep fixture');
    adminStore.emailAccounts.push({
      id: '00000000-0000-4000-8000-000000000099',
      userId: admin.id,
      address: 'admin-inbox@example.com',
      provider: 'gmail',
      syncStatus: 'LIVE',
      historyCursor: null,
      backfillCheckpoint: null,
      dailySendCount: 0,
      dailyCountDate: null,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    });

    renderSettings('inboxes', 'rep');
    await screen.findByRole('heading', { name: 'Inboxes', level: 1 });
    await screen.findByText('No inbox connected');
    expect(screen.queryByText('admin-inbox@example.com')).not.toBeInTheDocument();
    await expect(disconnectEmailAccount(adminStore.emailAccounts[0]!.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/Gmail address/));
    await user.type(screen.getByLabelText(/Gmail address/), 'rep-inbox@example.com');
    await user.click(screen.getByRole('button', { name: 'Connect Gmail' }));

    expect(await screen.findByText('rep-inbox@example.com')).toBeInTheDocument();
    expect(
      adminStore.emailAccounts.find((account) => account.address === 'rep-inbox@example.com')
        ?.userId,
    ).toBe(rep.id);
  });
});

describe('users section', () => {
  test('shows role chips and an active indicator', async () => {
    renderSettings('users');
    const adminRow = (await screen.findByText('Ada Okafor')).closest('tr');
    expect(adminRow).not.toBeNull();
    expect(within(adminRow as HTMLElement).getByText('admin')).toBeInTheDocument();
    expect(within(adminRow as HTMLElement).getByText('Active')).toBeInTheDocument();
  });
});

describe('custom fields', () => {
  test('lists seeded fields and creates a new one (store + toast + list)', async () => {
    const user = userEvent.setup();
    renderSettings('custom-fields');

    await screen.findByRole('heading', { name: 'Custom fields', level: 1 });
    expect(await screen.findByText('custom.segment')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Label'), 'Account tier');
    await user.type(screen.getByLabelText('Key'), 'account_tier');
    await user.click(screen.getByRole('button', { name: 'Add field' }));

    await screen.findByText('Created lead field “Account tier”');
    expect(await screen.findByText('custom.account_tier')).toBeInTheDocument();
    expect(adminStore.customFields.some((f) => f.key === 'account_tier')).toBe(true);
  });

  test('renders a failed-to-load ErrorState with a retry when the list load fails', async () => {
    server.use(
      http.get('*/api/v1/admin/custom-fields', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderSettings('custom-fields');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn’t load custom fields/);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  test('surfaces a validation error for a duplicate key', async () => {
    const user = userEvent.setup();
    renderSettings('custom-fields');
    await screen.findByRole('heading', { name: 'Custom fields', level: 1 });
    await screen.findByText('custom.segment'); // wait for the section to finish loading

    await user.type(screen.getByLabelText('Label'), 'Segment again');
    await user.type(screen.getByLabelText('Key'), 'segment');
    await user.click(screen.getByRole('button', { name: 'Add field' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
  });
});

describe('templates', () => {
  test('edits a template body in the drawer and saves (store + toast)', async () => {
    const user = userEvent.setup();
    renderSettings('templates');

    await screen.findByRole('heading', { name: /Templates/, level: 1 });
    const firstEdit = (await screen.findAllByRole('button', { name: /Edit/ }))[0];
    if (!firstEdit) throw new Error('no edit button');
    await user.click(firstEdit);

    const dialog = await screen.findByRole('dialog');
    const body = within(dialog).getByLabelText('Body');
    await user.clear(body);
    await user.type(body, 'Rewritten body for the demo.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await screen.findByText(/^Saved/);
    expect(adminStore.templates.some((t) => t.body === 'Rewritten body for the demo.')).toBe(true);
  });

  test('surfaces a save failure as a field error in the drawer', async () => {
    const user = userEvent.setup();
    renderSettings('templates');

    await screen.findByRole('heading', { name: /Templates/, level: 1 });
    const firstEdit = (await screen.findAllByRole('button', { name: /Edit/ }))[0];
    if (!firstEdit) throw new Error('no edit button');
    await user.click(firstEdit);

    const dialog = await screen.findByRole('dialog');
    server.use(
      http.patch('*/api/v1/templates/:id', () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_FAILED', message: 'name cannot be empty' } },
          { status: 400 },
        ),
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('name cannot be empty');
  });
});

describe('compliance', () => {
  test('recording is off with its audit rationale and is not toggleable', async () => {
    renderSettings('compliance');
    await screen.findByRole('heading', { name: 'Compliance', level: 1 });
    expect(await screen.findByText(/requires legal sign-off/)).toBeInTheDocument();
    // The only interactive control in the rails is the daily-cap Save button.
    expect(screen.queryByRole('switch')).toBeNull();
  });

  test('edits the daily send cap (store + toast)', async () => {
    const user = userEvent.setup();
    renderSettings('compliance');
    await screen.findByRole('heading', { name: 'Compliance', level: 1 });

    const capInput = await screen.findByLabelText('Daily send cap');
    await user.clear(capInput);
    await user.type(capInput, '275');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Daily send cap set to 275');
    expect(adminStore.orgSettings.dailySendCap).toBe(275);
  });

  test('rejects an out-of-range cap without writing', async () => {
    const user = userEvent.setup();
    renderSettings('compliance');
    await screen.findByRole('heading', { name: 'Compliance', level: 1 });

    const capInput = await screen.findByLabelText('Daily send cap');
    await user.clear(capInput);
    await user.type(capInput, '0');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(adminStore.orgSettings.dailySendCap).toBe(200);
  });
});
