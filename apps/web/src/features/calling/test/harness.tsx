import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Contact, Lead, User } from '@switchboard/shared';
import { ToastProvider } from '../../../feedback/index.ts';
import { KeyboardProvider } from '../../../keyboard/index.ts';
import { AuthProvider } from '../../../auth/AuthProvider.tsx';
import { storeUser } from '../../../auth/auth.ts';
import { ROUTER_FUTURE } from '../../../app/routerFuture.ts';
import type { CallClock } from '../context/CallProvider.tsx';

/** MSW path helper matching the app's `/api/v1` base. */
export const api = (path: string): string => `*/api/v1${path}`;

const TS = '2026-07-01T00:00:00.000Z';

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
    phones: [{ phone: '+12065550134', type: 'mobile' }],
    dnc: false,
    deletedAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

/** A controllable clock: manual `advance(ms)` fires due timers; `tick` moves now. */
export function makeFakeClock(startMs = 0): CallClock & {
  advance: (ms: number) => void;
} {
  let current = startMs;
  let seq = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  return {
    now: () => current,
    setTimeout: (fn, ms) => {
      const id = seq++;
      timers.set(id, { fireAt: current + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    setInterval: () => seq++,
    clearInterval: () => undefined,
    advance: (ms: number) => {
      current += ms;
      for (const [id, t] of [...timers.entries()]) {
        if (t.fireAt <= current) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

/** Render a calling UI inside the providers it needs (query · auth · toast · keyboard · router). */
export function renderCalling(
  ui: ReactElement,
  opts: { route?: string; user?: User | null } = {},
): RenderResult {
  storeUser(opts.user === undefined ? makeUser() : opts.user);
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
