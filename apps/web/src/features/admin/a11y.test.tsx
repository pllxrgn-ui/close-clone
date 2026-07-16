import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Lead } from '@switchboard/shared';
import { ToastProvider } from '../../feedback/ToastProvider.tsx';
import { db } from '../../mocks/fixtures.ts';
import { server } from '../../mocks/server.ts';
import { adminHandlers } from './mocks/adminHandlers.ts';
import { resetAdminStore } from './mocks/adminStore.ts';
import { AdminSettingsPage } from './settings/AdminSettingsPage.tsx';
import { LeadBulkActions } from './bulk/LeadBulkActions.tsx';

/*
 * axe-core structural smoke for the S5 surfaces, under both themes. color-contrast
 * can't run in jsdom (the AA pairs are verified statically in tokens.css), so it is
 * disabled here; the gate is zero serious/critical violations — matching the W1 /
 * leads acceptance bar.
 */

const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, AXE_OPTIONS);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const summary = blocking.map((v) => `${v.id} (${String(v.impact)}): ${v.help}`).join('\n');
  expect(summary).toBe('');
}

function Providers({ children }: { children: JSX.Element }): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider ttl={0}>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  resetAdminStore();
  server.use(...adminHandlers);
  document.documentElement.lang = 'en';
});
afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  cleanup();
});

describe('settings — axe', () => {
  test('the custom-fields section has no serious/critical violations (light + dark)', async () => {
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.dataset.theme = theme;
      const { container, unmount } = render(
        <Providers>
          <MemoryRouter initialEntries={['/settings?section=custom-fields']}>
            <AdminSettingsPage />
          </MemoryRouter>
        </Providers>,
      );
      await screen.findByRole('heading', { name: 'Custom fields', level: 1 });
      await screen.findByText('custom.segment');
      await expectNoSeriousViolations(container);
      unmount();
    }
  });

  test('the compliance section has no serious/critical violations (light + dark)', async () => {
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.dataset.theme = theme;
      const { container, unmount } = render(
        <Providers>
          <MemoryRouter initialEntries={['/settings?section=compliance']}>
            <AdminSettingsPage />
          </MemoryRouter>
        </Providers>,
      );
      await screen.findByLabelText('Daily send cap');
      await expectNoSeriousViolations(container);
      unmount();
    }
  });
});

describe('bulk dialog — axe', () => {
  test('the DNC reason dialog has no serious/critical violations', async () => {
    const user = userEvent.setup();
    const lead = db.leads.find((l) => !l.dnc) as Lead;
    document.documentElement.dataset.theme = 'dark';
    render(
      <Providers>
        <LeadBulkActions selectedLeads={[lead]} />
      </Providers>,
    );
    await user.click(await screen.findByRole('button', { name: 'Set DNC' }));
    await screen.findByRole('dialog');
    await expectNoSeriousViolations(document.body);
  });
});
