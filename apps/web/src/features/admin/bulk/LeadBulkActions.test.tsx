import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Lead } from '@switchboard/shared';
import { ToastProvider } from '../../../feedback/ToastProvider.tsx';
import { db } from '../../../mocks/fixtures.ts';
import { server } from '../../../mocks/server.ts';
import { adminHandlers } from '../mocks/adminHandlers.ts';
import { adminStore, resetAdminStore } from '../mocks/adminStore.ts';
import { LeadBulkActions } from './LeadBulkActions.tsx';

/*
 * Bulk-bar integration: each action mutates the store + the leads cache, confirms
 * with a counted toast, and the compliance-aware enroll splits its count. Uses
 * the real admin handlers so the shared leads db and admin store are the store
 * under test (mutated leads are restored after each test).
 */

const restores: Array<() => void> = [];
function useLead(predicate: (l: Lead) => boolean): Lead {
  const lead = db.leads.find(predicate);
  if (!lead) throw new Error('fixture lacks a matching lead');
  const { ownerId, statusId, dnc, updatedAt } = lead;
  restores.push(() => {
    lead.ownerId = ownerId;
    lead.statusId = statusId;
    lead.dnc = dnc;
    lead.updatedAt = updatedAt;
  });
  return lead;
}

function renderBar(leads: Lead[]): { qc: QueryClient; onDone: ReturnType<typeof vi.fn> } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['leads', 'all'], { pages: [{ items: leads }], pageParams: [undefined] });
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider ttl={0}>
        <LeadBulkActions selectedLeads={leads} onDone={onDone} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { qc, onDone };
}

function cachedLead(qc: QueryClient, id: string): Lead | undefined {
  const data = qc.getQueryData<{ pages: Array<{ items: Lead[] }> }>(['leads', 'all']);
  return data?.pages[0]?.items.find((l) => l.id === id);
}

beforeEach(() => {
  resetAdminStore();
  server.use(...adminHandlers);
});
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  cleanup();
  vi.restoreAllMocks();
});

describe('assign owner', () => {
  test('mutates the store + cache optimistically and toasts the count', async () => {
    const user = userEvent.setup();
    const owner = db.users[3];
    if (!owner) throw new Error('need a user');
    const a = useLead((l) => !l.dnc && l.ownerId !== owner.id);
    const b = useLead((l) => !l.dnc && l.ownerId !== owner.id && l.id !== a.id);
    const { qc, onDone } = renderBar([a, b]);

    await user.click(await screen.findByRole('button', { name: 'Assign owner' }));
    await user.click(await screen.findByRole('option', { name: new RegExp(owner.name) }));

    await screen.findByText(`2 leads assigned to ${owner.name}`);
    expect(db.leads.find((l) => l.id === a.id)?.ownerId).toBe(owner.id);
    expect(cachedLead(qc, a.id)?.ownerId).toBe(owner.id); // optimistic
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('edit status', () => {
  test('sets the status on the selection and toasts', async () => {
    const user = userEvent.setup();
    const status = db.leadStatuses.find((s) => s.label === 'Qualified');
    if (!status) throw new Error('need Qualified status');
    const a = useLead((l) => l.statusId !== status.id);
    const { qc } = renderBar([a]);

    await user.click(await screen.findByRole('button', { name: 'Edit status' }));
    await user.click(await screen.findByRole('option', { name: 'Qualified' }));

    await screen.findByText('1 lead set to Qualified');
    expect(db.leads.find((l) => l.id === a.id)?.statusId).toBe(status.id);
    expect(cachedLead(qc, a.id)?.statusId).toBe(status.id);
  });
});

describe('enroll in sequence (I-DNC split)', () => {
  test('enrolls non-DNC, skips DNC, ticks the count, and reports the split', async () => {
    const user = userEvent.setup();
    const ok = useLead((l) => !l.dnc);
    const dnc = useLead((l) => l.dnc);
    renderBar([ok, dnc]);
    const before =
      adminStore.sequences.find((s) => s.id === 'seq-onboarding')?.activeEnrollments ?? 0;

    await user.click(await screen.findByRole('button', { name: 'Enroll in sequence' }));
    await user.click(await screen.findByRole('option', { name: /Onboarding/ }));

    await screen.findByText('1 lead enrolled in Onboarding · 1 skipped (DNC)');
    expect(adminStore.sequences.find((s) => s.id === 'seq-onboarding')?.activeEnrollments).toBe(
      before + 1,
    );
  });
});

describe('export CSV', () => {
  test('downloads a CSV of the selection and toasts', async () => {
    const user = userEvent.setup();
    // Assign the methods directly (jsdom may not define createObjectURL) and
    // restore them — never replace the whole URL global, which would break the
    // `new URL()` MSW relies on in later tests.
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => 'blob:mock');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    restores.push(() => {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const a = useLead(() => true);
    renderBar([a]);

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await screen.findByText('Exported 1 lead to CSV');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});

describe('set DNC (required reason)', () => {
  test('requires a reason, then flips DNC on the selection with a toast', async () => {
    const user = userEvent.setup();
    const a = useLead((l) => !l.dnc);
    const { qc } = renderBar([a]);

    await user.click(await screen.findByRole('button', { name: 'Set DNC' }));
    // Confirm is disabled until a reason is chosen.
    const confirm = await screen.findByRole('button', { name: 'Mark Do Not Contact' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByLabelText('Requested by contact'));
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await screen.findByText('1 lead marked Do Not Contact');
    expect(db.leads.find((l) => l.id === a.id)?.dnc).toBe(true);
    expect(cachedLead(qc, a.id)?.dnc).toBe(true);
  });
});

describe('failure path', () => {
  test('rolls back the optimistic change and toasts an error when the API rejects', async () => {
    const user = userEvent.setup();
    const owner = db.users[2];
    if (!owner) throw new Error('need a user');
    const a = useLead((l) => !l.dnc && l.ownerId !== owner.id);
    const originalOwner = a.ownerId;
    server.use(
      http.patch('*/api/v1/leads/:id', () =>
        HttpResponse.json({ error: { code: 'SUPPRESSED', message: 'blocked' } }, { status: 422 }),
      ),
    );
    const { qc } = renderBar([a]);

    await user.click(await screen.findByRole('button', { name: 'Assign owner' }));
    await user.click(await screen.findByRole('option', { name: new RegExp(owner.name) }));

    await screen.findByText(/Couldn’t assign/);
    await waitFor(() => expect(cachedLead(qc, a.id)?.ownerId).toBe(originalOwner)); // rolled back
  });
});
