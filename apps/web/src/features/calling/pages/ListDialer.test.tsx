import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { Lead } from '@switchboard/shared';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { callingHandlers, type DialerEntry } from '../mocks/callingHandlers.ts';
import { isPhoneSuppressed, resetCallsStore } from '../data/callsStore.ts';
import { CallProvider } from '../context/CallProvider.tsx';
import { ListDialer } from './ListDialer.tsx';
import { api, renderCalling } from '../test/harness.tsx';

/*
 * Tests for the list dialer. The queue is stubbed from REAL fixture leads (so the
 * sequential advance resolves against the dial engine) to make the on-deck order,
 * the DNC-blocked rows, the skip-advance, and placing a call deterministic — not
 * dependent on the fixture's DNC distribution.
 */

function dialableLeads(count: number): Array<{ lead: Lead; phone: string }> {
  const out: Array<{ lead: Lead; phone: string }> = [];
  for (const lead of db.leads) {
    if (lead.dnc || lead.deletedAt !== null) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && c.phones.length > 0,
    );
    const phone = contact?.phones[0]?.phone;
    if (contact && phone && !contact.dnc && !isPhoneSuppressed(phone)) {
      out.push({ lead, phone });
      if (out.length === count) break;
    }
  }
  if (out.length < count) throw new Error('fixture lacks enough dialable leads');
  return out;
}

function findDncLead(): Lead {
  const lead = db.leads.find((l) => l.dnc && l.deletedAt === null);
  if (!lead) throw new Error('fixture has no DNC lead');
  return lead;
}

function entry(over: Partial<DialerEntry> & Pick<DialerEntry, 'leadId' | 'leadName'>): DialerEntry {
  return {
    contactId: null,
    phone: '+12065550100',
    dnc: false,
    suppressed: false,
    dialable: true,
    ...over,
  };
}

function stubQueue(items: DialerEntry[]): void {
  server.use(http.post(api('/calls/dialer/queue'), () => HttpResponse.json({ items })));
}

beforeEach(() => {
  resetCallsStore();
  server.use(...callingHandlers);
});
afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  cleanup();
});

describe('ListDialer', () => {
  test('loads a queue and seats the on-deck lead on the first callable', async () => {
    renderCalling(
      <CallProvider>
        <ListDialer />
      </CallProvider>,
      { route: '/dialer' },
    );
    await screen.findByTestId('dialer-ondeck');
    expect(screen.getByText('List dialer')).toBeInTheDocument();
    expect(screen.getByText(/callable/)).toBeInTheDocument();
  });

  test('shows DNC rows blocked and skips them when advancing', async () => {
    const two = dialableLeads(2);
    const a = two[0]!;
    const c = two[1]!;
    const dnc = findDncLead();
    stubQueue([
      entry({ leadId: a.lead.id, leadName: a.lead.name, phone: a.phone }),
      entry({
        leadId: dnc.id,
        leadName: dnc.name,
        phone: '+12065559999',
        dnc: true,
        dialable: false,
      }),
      entry({ leadId: c.lead.id, leadName: c.lead.name, phone: c.phone }),
    ]);
    const user = userEvent.setup();
    renderCalling(
      <CallProvider>
        <ListDialer />
      </CallProvider>,
      { route: '/dialer' },
    );

    const onDeck = await screen.findByTestId('dialer-ondeck');
    expect(within(onDeck).getByText(a.lead.name)).toBeInTheDocument();

    // The DNC lead is a blocked row with the rail pill, never the on-deck.
    const blockedRows = document.querySelectorAll('.dialer__row[data-blocked]');
    expect(blockedRows).toHaveLength(1);
    expect(within(blockedRows[0] as HTMLElement).getByText('Do not contact')).toBeInTheDocument();

    // Skip advances past the DNC lead straight to the next callable one.
    await user.click(screen.getByRole('button', { name: /Skip/ }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('dialer-ondeck')).getByText(c.lead.name),
      ).toBeInTheDocument(),
    );
  });

  test('placing the on-deck call opens the global strip (sequential advance)', async () => {
    const a = dialableLeads(1)[0]!;
    stubQueue([entry({ leadId: a.lead.id, leadName: a.lead.name, phone: a.phone })]);
    const user = userEvent.setup();
    renderCalling(
      <CallProvider timings={{ dialMs: 50, ringMs: 50 }}>
        <ListDialer />
      </CallProvider>,
      { route: '/dialer' },
    );
    await screen.findByTestId('dialer-ondeck');
    await user.click(screen.getByRole('button', { name: /Call/ }));
    expect(
      await screen.findByRole('region', { name: new RegExp(`Call with ${a.lead.name}`) }),
    ).toBeInTheDocument();
  });

  test('the N shortcut advances to the next lead', async () => {
    const two = dialableLeads(2);
    const a = two[0]!;
    const b = two[1]!;
    stubQueue([
      entry({ leadId: a.lead.id, leadName: a.lead.name, phone: a.phone }),
      entry({ leadId: b.lead.id, leadName: b.lead.name, phone: b.phone }),
    ]);
    const user = userEvent.setup();
    renderCalling(
      <CallProvider>
        <ListDialer />
      </CallProvider>,
      { route: '/dialer' },
    );
    const onDeck = await screen.findByTestId('dialer-ondeck');
    expect(within(onDeck).getByText(a.lead.name)).toBeInTheDocument();
    await user.keyboard('n');
    await waitFor(() =>
      expect(
        within(screen.getByTestId('dialer-ondeck')).getByText(b.lead.name),
      ).toBeInTheDocument(),
    );
  });

  test('an empty queue shows the empty state', async () => {
    stubQueue([]);
    renderCalling(
      <CallProvider>
        <ListDialer />
      </CallProvider>,
      { route: '/dialer' },
    );
    expect(await screen.findByText('No callable leads in this view')).toBeInTheDocument();
  });
});
