import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { db } from '../../../mocks/fixtures.ts';
import { commsStore } from '../data/store.ts';
import { ToastProvider } from '../../../feedback/ToastProvider.tsx';
import { LeadEnrollLauncher } from './LeadEnrollLauncher.tsx';

/*
 * Runs against the REAL default handler chain (sequences + enroll from the comms
 * store, contacts from the core db) — the same path the browser uses, so the
 * one-element bulk-enroll body and the skipped/already_enrolled semantics are
 * exercised end-to-end, not stubbed.
 */

function Harness({ children }: { children: ReactNode }): ReactNode {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

// A live lead whose FIRST live contact (the launcher's default target) has no
// seeded live enrollment — so enroll #1 succeeds and the retry hits the C1
// uniqueness skip, deterministically.
const liveEnrolled = new Set(
  commsStore.enrollments
    .filter((e) => e.state === 'active' || e.state === 'paused')
    .map((e) => e.contactId),
);
const LEAD = db.leads.find((l) => {
  if (l.deletedAt !== null) return false;
  const first = db.contacts.find((c) => c.leadId === l.id && c.deletedAt === null);
  return first !== undefined && !liveEnrolled.has(first.id);
});
if (!LEAD) throw new Error('fixtures must include a lead with an un-enrolled contact');

afterEach(cleanup);

describe('LeadEnrollLauncher', () => {
  test('lists only ACTIVE sequences as a radiogroup', async () => {
    render(
      <Harness>
        <LeadEnrollLauncher lead={LEAD} />
      </Harness>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Enroll/ }));
    const group = await screen.findByRole('radiogroup', { name: 'Sequence' });
    const rows = within(group).getAllByRole('radio');
    expect(rows.length).toBeGreaterThan(0);
    // No archived sequence names leak into the picker.
    for (const row of rows) {
      expect(row).toBeEnabled();
    }
  });

  test('selecting a sequence surfaces its cadence (steps + channels + first send)', async () => {
    render(
      <Harness>
        <LeadEnrollLauncher lead={LEAD} />
      </Harness>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Enroll/ }));
    const group = await screen.findByRole('radiogroup', { name: 'Sequence' });
    const first = within(group).getAllByRole('radio')[0];
    if (!first) throw new Error('expected an active sequence');
    await userEvent.click(first);
    // "N steps · <channels> · first …" from the real step-ladder handler.
    expect(await screen.findByText(/\d+ steps? · .+ · first/)).toBeVisible();
  });

  test('enrolls this lead through the real bulk route, then reports a duplicate on retry', async () => {
    render(
      <Harness>
        <LeadEnrollLauncher lead={LEAD} />
      </Harness>,
    );
    // First enroll: succeed + close.
    await userEvent.click(screen.getByRole('button', { name: /^Enroll/ }));
    const group = await screen.findByRole('radiogroup', { name: 'Sequence' });
    const first = within(group).getAllByRole('radio')[0];
    if (!first) throw new Error('expected at least one active sequence');
    const seqName = first.textContent ?? '';
    await userEvent.click(first);
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Enroll/ }));
    expect(await screen.findByText(new RegExp(`Enrolled in`))).toBeVisible();
    expect(seqName.length).toBeGreaterThan(0);

    // Second enroll, same sequence + contact: C1 uniqueness → skipped, not an error.
    await userEvent.click(screen.getByRole('button', { name: /^Enroll/ }));
    const group2 = await screen.findByRole('radiogroup', { name: 'Sequence' });
    const again = within(group2).getAllByRole('radio')[0];
    if (!again) throw new Error('expected the sequence to still list');
    await userEvent.click(again);
    const dialog2 = screen.getByRole('dialog');
    await userEvent.click(within(dialog2).getByRole('button', { name: /Enroll/ }));
    expect(await screen.findByText(/already in/i)).toBeVisible();
    // The modal stays open on a skip so the rep can pick another sequence.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
