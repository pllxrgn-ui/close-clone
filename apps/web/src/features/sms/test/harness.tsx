import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Contact, Lead, SmsMessage, User } from '@switchboard/shared';
import { ToastProvider } from '../../../feedback/index.ts';
import { AuthProvider } from '../../../auth/AuthProvider.tsx';
import { storeUser } from '../../../auth/auth.ts';
import { KeyboardProvider } from '../../../keyboard/index.ts';
import { ROUTER_FUTURE } from '../../../app/routerFuture.ts';

/** MSW path helper matching the app's `/api/v1` base. */
export const api = (path: string): string => `*/api/v1${path}`;

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
    phones: [{ phone: '+12065551234', type: 'mobile' }],
    dnc: false,
    deletedAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

export function makeSms(over: Partial<SmsMessage> = {}): SmsMessage {
  return {
    id: 'sms1',
    leadId: 'L1',
    contactId: 'c1',
    userId: 'u1',
    direction: 'outbound',
    fromNumber: '+12065550100',
    toNumber: '+12065551234',
    body: 'Hello there',
    providerSid: 'SM1',
    status: 'delivered',
    sentAt: TS,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

/** Render an SMS UI inside every provider it needs (query · auth · toast · keyboard · router). */
export function renderSms(
  ui: ReactElement,
  opts: { route?: string; user?: User } = {},
): RenderResult {
  storeUser(opts.user ?? makeUser());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ToastProvider>
          <KeyboardProvider>
            <MemoryRouter initialEntries={[opts.route ?? '/']} future={ROUTER_FUTURE}>
              {ui}
            </MemoryRouter>
          </KeyboardProvider>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}
