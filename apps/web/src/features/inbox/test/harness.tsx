import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KeyboardProvider } from '../../../keyboard/index.ts';
import { ToastProvider } from '../../../feedback/index.ts';
import { InboxSurface } from '../components/InboxSurface.tsx';
import type { InboxStoreData, StoredReview, StoredTask, StoredThread } from '../model/store.ts';
import { INBOX_NOW_MS } from '../model/time.ts';

/* Test seams for the Inbox: a provider harness plus deterministic store builders. */

const ago = (ms: number): string => new Date(INBOX_NOW_MS - ms).toISOString();
const H = 3_600_000;
const D = 24 * H;

export function providers(ui: ReactElement): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <KeyboardProvider>
        <ToastProvider>{ui}</ToastProvider>
      </KeyboardProvider>
    </QueryClientProvider>
  );
}

export function renderInbox(): RenderResult {
  return render(providers(<InboxSurface />));
}

export function makeThread(over: Partial<StoredThread> & { id: string }): StoredThread {
  return {
    leadId: 'L1',
    contactId: 'c1',
    contactName: 'Sam Patel',
    channel: 'email',
    toAddress: 'sam@north.test',
    subject: 'Re: pilot',
    snippet: 'Two quick questions on the terms…',
    lastInboundAt: ago(2 * H),
    lastContactedAt: ago(3 * D),
    answered: false,
    answeredAt: null,
    snoozedUntil: null,
    messages: [
      { id: 'm1', direction: 'in', subject: 'Re: pilot', body: 'Two questions…', at: ago(2 * H) },
    ],
    ...over,
  };
}

export function makeTask(over: Partial<StoredTask> & { id: string }): StoredTask {
  return {
    leadId: 'L1',
    title: 'Follow up on pricing',
    dueAt: ago(2 * D),
    completedAt: null,
    snoozedUntil: null,
    ...over,
  };
}

export function makeReview(over: Partial<StoredReview> & { id: string }): StoredReview {
  return {
    leadId: 'L1',
    enrollmentId: 'en1',
    stepId: 'sp1',
    sequenceId: 'sq1',
    contactId: 'c1',
    contactName: 'Sam Patel',
    sequenceName: 'Onboarding',
    stepIndex: 2,
    stepCount: 4,
    channel: 'email',
    subject: 'A quick idea',
    preview: 'Hi Sam…',
    dueAt: ago(5 * H),
    state: 'AWAITING_REVIEW',
    disposition: null,
    dispositionedAt: null,
    snoozedUntil: null,
    ...over,
  };
}

export interface MakeStoreInput {
  threads?: StoredThread[];
  tasks?: StoredTask[];
  reviews?: StoredReview[];
  leadNames?: Array<[string, string]>;
  leadDnc?: Array<[string, boolean]>;
}

export function makeStore(input: MakeStoreInput = {}): InboxStoreData {
  return {
    threads: new Map((input.threads ?? []).map((t) => [t.id, t])),
    tasks: new Map((input.tasks ?? []).map((t) => [t.id, t])),
    reviews: new Map((input.reviews ?? []).map((r) => [r.id, r])),
    leadNames: new Map(input.leadNames ?? [['L1', 'North Labs']]),
    leadDnc: new Map(input.leadDnc ?? [['L1', false]]),
  };
}

/** Read a header stat's current numeric value from its tinted value element. */
export function statValue(container: HTMLElement, tone: 'neutral' | 'overdue' | 'done'): number {
  const el = container.querySelector(`.sb-inbox__stat-value--${tone}`);
  return Number(el?.textContent ?? 'NaN');
}
