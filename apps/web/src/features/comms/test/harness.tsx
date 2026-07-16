import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Contact, Lead, Snippet, Template, User } from '@switchboard/shared';
import { ToastProvider } from '../../../feedback/index.ts';
import { ROUTER_FUTURE } from '../../../app/routerFuture.ts';

/** MSW path helper matching the app's `/api/v1` base. */
export const api = (path: string): string => `*/api/v1${path}`;

/** Render a comms UI inside the providers it needs (query · toast · router). */
export function renderComms(ui: ReactElement, route = '/'): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[route]} future={ROUTER_FUTURE}>
          {ui}
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const TS = '2026-07-01T00:00:00.000Z';

export function makeUser(over: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'ben@switchboard.test',
    name: 'Ben Reyes',
    role: 'rep',
    idpSubject: 'dev|ben',
    isActive: true,
    timezone: 'America/New_York',
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

export function makeLead(over: Partial<Lead> = {}): Lead {
  return {
    id: 'L1',
    name: 'North Labs',
    url: null,
    description: null,
    statusId: null,
    ownerId: 'u1',
    custom: {},
    lastContactedAt: null,
    lastInboundAt: null,
    nextTaskDueAt: null,
    lastCallAt: null,
    lastEmailAt: null,
    lastSmsAt: null,
    dnc: false,
    deletedAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

export function makeContact(over: Partial<Contact> = {}): Contact {
  return {
    id: 'c1',
    leadId: 'L1',
    name: 'Sam Patel',
    title: 'VP Sales',
    emails: [{ email: 'sam@northlabs.example.com', type: 'work' }],
    phones: [],
    dnc: false,
    deletedAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

export function makeTemplate(over: Partial<Template> = {}): Template {
  return {
    id: 't1',
    name: 'Intro',
    channel: 'email',
    subject: 'Hi {{lead.name}}',
    body: 'Hi {{contact.first_name}}, from {{owner.name}}.',
    ownerId: null,
    shared: true,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

export function makeSnippet(over: Partial<Snippet> = {}): Snippet {
  return {
    id: 's1',
    shortcut: 'avail',
    body: 'I am available Thursday',
    ownerId: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}
