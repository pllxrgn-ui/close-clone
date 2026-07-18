import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server.ts';
import { AuthProvider } from '../../../auth/AuthProvider.tsx';
import { ShellFeatureProviders } from '../../../test/shellProviders.tsx';
import { LeadDetail } from './LeadDetail.tsx';
import {
  makeActivity,
  makeContact,
  makeLead,
  makeOpportunity,
  makeStage,
  makeStatus,
  makeUser,
} from '../test/factories.ts';

const api = (p: string): string => `*/api/v1${p}`;

const user = makeUser({ id: 'u1', name: 'Ben Reyes' });
const status = makeStatus({ id: 'st1', label: 'Qualified' });
const stage = makeStage({ id: 'sg1', label: 'Proposal' });
const lead = makeLead({
  name: 'North Labs',
  statusId: status.id,
  ownerId: user.id,
  dnc: true,
  url: 'https://north-labs.example.com',
});
const contact = makeContact({ leadId: lead.id, name: 'Sam Patel', title: 'VP Sales' });
const opp = makeOpportunity({
  leadId: lead.id,
  valueCents: 5_000_000,
  stageId: stage.id,
  status: 'active',
});
const events = [
  makeActivity({ type: 'email_received', leadId: lead.id, payload: { subject: 'Re: pilot' } }),
  makeActivity({ type: 'call_logged', leadId: lead.id, userId: user.id }),
];

function installHappyPath(): void {
  server.use(
    http.get(api('/users'), () => HttpResponse.json([user])),
    http.get(api('/lead-statuses'), () => HttpResponse.json([status])),
    http.get(api('/opportunity-stages'), () => HttpResponse.json([stage])),
    http.get(api('/leads/:id/timeline'), () => HttpResponse.json({ items: events })),
    http.get(api('/leads/:id'), ({ params }) =>
      params.id === lead.id
        ? HttpResponse.json(lead)
        : HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 }),
    ),
    http.get(api('/contacts'), () => HttpResponse.json([contact])),
    http.get(api('/opportunities'), () => HttpResponse.json([opp])),
  );
}

function renderDetail(leadId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/leads/${leadId}`]}>
        <AuthProvider>
          <ShellFeatureProviders>
            <LeadDetail leadId={leadId} />
          </ShellFeatureProviders>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('LeadDetail — header', () => {
  beforeEach(installHappyPath);

  test('renders identity, status, owner, and a prominent DNC indicator', async () => {
    renderDetail(lead.id);
    const heading = await screen.findByRole('heading', { name: 'North Labs', level: 1 });
    // Owner appears in the header AND as a timeline actor — scope to the header.
    const header = heading.closest('header');
    if (!(header instanceof HTMLElement)) throw new Error('lead header not found');
    expect(within(header).getByText('Qualified')).toBeInTheDocument();
    expect(within(header).getByText('Ben Reyes')).toBeInTheDocument();
    expect(within(header).getByText('Do not contact')).toBeInTheDocument();
  });

  test('next-action bar: all five actions are live; Call alone hard-blocks on DNC', async () => {
    renderDetail(lead.id);
    const group = await screen.findByRole('group', { name: /Lead actions/ });
    // The launchers are lazy-loaded behind one Suspense boundary — await the
    // first to resolve it. Email/SMS/Task/Enroll stay enabled even for this DNC
    // lead: their compliance gates fire at send / in-thread / at each sequence
    // send, not on the button.
    expect(await within(group).findByRole('button', { name: 'Email' })).toBeEnabled();
    expect(within(group).getByRole('button', { name: /SMS/ })).toBeEnabled();
    expect(within(group).getByRole('button', { name: /Task/ })).toBeEnabled();
    expect(within(group).getByRole('button', { name: /Enroll/ })).toBeEnabled();
    // Dialing a do-not-contact lead is impossible from the UI, not just refused
    // by the engine → the Call launcher hard-disables.
    expect(within(group).getByRole('button', { name: /Call/ })).toBeDisabled();
  });
});

describe('LeadDetail — timeline + right rail', () => {
  beforeEach(installHappyPath);

  test('center timeline renders C4 events', async () => {
    renderDetail(lead.id);
    expect(await screen.findByText('Email received')).toBeInTheDocument();
    expect(screen.getByText('Call logged')).toBeInTheDocument();
    expect(screen.getByText('Re: pilot')).toBeInTheDocument();
  });

  test('right rail shows read-only contacts and opportunities', async () => {
    renderDetail(lead.id);
    const contacts = await screen.findByRole('region', { name: 'Contacts' });
    expect(within(contacts).getByText('Sam Patel')).toBeInTheDocument();
    expect(within(contacts).getByText('VP Sales')).toBeInTheDocument();

    const opps = screen.getByRole('region', { name: 'Opportunities' });
    expect(within(opps).getByText('$50,000')).toBeInTheDocument();
    expect(within(opps).getByText('Proposal')).toBeInTheDocument();
  });
});

describe('LeadDetail — failure paths', () => {
  test('a 404 lead renders a not-found state with a way back', async () => {
    server.use(
      http.get(api('/users'), () => HttpResponse.json([user])),
      http.get(api('/lead-statuses'), () => HttpResponse.json([status])),
      http.get(api('/opportunity-stages'), () => HttpResponse.json([stage])),
      http.get(api('/leads/:id/timeline'), () => HttpResponse.json({ items: [] })),
      http.get(api('/contacts'), () => HttpResponse.json([])),
      http.get(api('/opportunities'), () => HttpResponse.json([])),
      http.get(api('/leads/:id'), () =>
        HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 }),
      ),
    );
    renderDetail('missing-lead');
    expect(await screen.findByText('Lead not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to leads' })).toBeInTheDocument();
  });

  test('a contacts-fetch failure is isolated to its card', async () => {
    installHappyPath();
    server.use(
      http.get(api('/contacts'), () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderDetail(lead.id);
    // Lead + timeline still render; only the contacts card shows an error.
    expect(await screen.findByText('North Labs')).toBeInTheDocument();
    const contacts = screen.getByRole('region', { name: 'Contacts' });
    expect(within(contacts).getByRole('alert')).toHaveTextContent('Couldn’t load contacts');
  });
});
