import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Call, Contact, Lead, User } from '@switchboard/shared';
import { AuthProvider } from '../../../auth/AuthProvider.tsx';
import { storeUser } from '../../../auth/auth.ts';
import { ToastProvider } from '../../../feedback/index.ts';
import { ROUTER_FUTURE } from '../../../app/routerFuture.ts';

/** MSW path helper matching the app's `/api/v1` base. */
export const api = (path: string): string => `*/api/v1${path}`;

const TS = '2026-07-01T00:00:00.000Z';

/**
 * Seed a signed-in fixture user into localStorage BEFORE rendering, so
 * `AuthProvider` restores it synchronously and `useAuth().user` is non-null.
 * The AI confirm path needs a `confirmedBy` uuid (§I-AI); this is that user.
 */
export function signInAs(user: User = makeUser()): User {
  storeUser(user);
  return user;
}

/** Clear the persisted session between tests. */
export function signOut(): void {
  storeUser(null);
}

/** Render an AI UI inside the providers it needs (query · toast · router · auth). */
export function renderAi(ui: ReactElement, route = '/'): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[route]} future={ROUTER_FUTURE}>
            {ui}
          </MemoryRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

export function makeUser(over: Partial<User> = {}): User {
  return {
    id: '11111111-1111-4111-8111-111111111111',
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
    ownerId: '11111111-1111-4111-8111-111111111111',
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
    phones: [{ phone: '+12065550143', type: 'mobile' }],
    dnc: false,
    deletedAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

export function makeCall(over: Partial<Call> = {}): Call {
  return {
    id: 'call-1',
    leadId: 'L1',
    contactId: 'c1',
    userId: '11111111-1111-4111-8111-111111111111',
    direction: 'outbound',
    twilioSid: null,
    status: 'completed',
    durationS: 420,
    outcome: 'connected',
    recordingRef: 'rec://call-1',
    transcriptRef: 'txn://call-1',
    startedAt: TS,
    endedAt: TS,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}
