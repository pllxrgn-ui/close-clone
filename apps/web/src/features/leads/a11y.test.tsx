import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { KeyboardProvider } from '../../keyboard/index.ts';
import { server } from '../../mocks/server.ts';
import { LeadsSurface } from './components/LeadsSurface.tsx';
import { LeadDetail } from './components/LeadDetail.tsx';
import { installVirtualizerEnv } from './test/harness.tsx';
import {
  makeActivity,
  makeContact,
  makeLead,
  makeOpportunity,
  makeStage,
  makeStatus,
  makeUser,
} from './test/factories.ts';

/*
 * axe-core structural smoke for the W3 surfaces (color-contrast can't run in
 * jsdom — the AA pairs are verified statically in tokens.css). Fails only on
 * serious/critical, matching the W1 acceptance bar, and runs under both themes.
 */

const api = (p: string): string => `*/api/v1${p}`;
const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, AXE_OPTIONS);
  expect(results.passes.length).toBeGreaterThan(0);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const summary = blocking.map((v) => `${v.id} (${String(v.impact)}): ${v.help}`).join('\n');
  expect(summary).toBe('');
}

const user = makeUser({ id: 'u1', name: 'Ben Reyes' });
const status = makeStatus({ id: 'st1', label: 'Qualified' });
const stage = makeStage({ id: 'sg1', label: 'Proposal' });

function renderSurface(): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <KeyboardProvider>
        <MemoryRouter initialEntries={['/leads']}>
          <LeadsSurface viewId={null} />
        </MemoryRouter>
      </KeyboardProvider>
    </QueryClientProvider>
  );
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = installVirtualizerEnv({ height: 640 });
  document.documentElement.lang = 'en';
});
afterEach(() => {
  restoreEnv();
  document.documentElement.removeAttribute('data-theme');
  cleanup();
});

describe('leads surface — axe', () => {
  test('the leads grid has no serious/critical violations (light + dark)', async () => {
    server.use(
      http.get(api('/users'), () => HttpResponse.json([user])),
      http.get(api('/lead-statuses'), () => HttpResponse.json([status])),
      http.get(api('/smart-views'), () => HttpResponse.json([])),
      http.get(api('/leads'), () =>
        HttpResponse.json({
          items: [
            makeLead({ name: 'North Labs', statusId: status.id, ownerId: user.id, dnc: true }),
            makeLead({ name: 'Cedar Systems', statusId: status.id, ownerId: user.id }),
          ],
        }),
      ),
    );

    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.dataset.theme = theme;
      const { container, unmount } = render(renderSurface());
      await screen.findByRole('grid');
      await expectNoSeriousViolations(container);
      unmount();
    }
  });
});

describe('lead page — axe', () => {
  test('the lead detail has no serious/critical violations', async () => {
    const lead = makeLead({ name: 'North Labs', statusId: status.id, ownerId: user.id, dnc: true });
    server.use(
      http.get(api('/users'), () => HttpResponse.json([user])),
      http.get(api('/lead-statuses'), () => HttpResponse.json([status])),
      http.get(api('/opportunity-stages'), () => HttpResponse.json([stage])),
      http.get(api('/leads/:id'), () => HttpResponse.json(lead)),
      http.get(api('/leads/:id/timeline'), () =>
        HttpResponse.json({
          items: [
            makeActivity({ type: 'email_received', payload: { subject: 'Re: pilot' } }),
            makeActivity({ type: 'call_logged', userId: user.id }),
          ],
        }),
      ),
      http.get(api('/contacts'), () => HttpResponse.json([makeContact({ leadId: lead.id })])),
      http.get(api('/opportunities'), () =>
        HttpResponse.json([makeOpportunity({ leadId: lead.id, stageId: stage.id })]),
      ),
    );

    document.documentElement.dataset.theme = 'dark';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/leads/${lead.id}`]}>
          <LeadDetail leadId={lead.id} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('heading', { name: 'North Labs', level: 1 });
    await expectNoSeriousViolations(container);
  });
});
