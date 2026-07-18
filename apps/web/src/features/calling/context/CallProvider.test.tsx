import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import type { Contact, Lead } from '@switchboard/shared';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { callingHandlers } from '../mocks/callingHandlers.ts';
import { isPhoneSuppressed, resetCallsStore } from '../data/callsStore.ts';
import { CallProvider, useCall } from './CallProvider.tsx';
import { LeadCallLauncher } from '../components/LeadCallLauncher.tsx';
import { makeFakeClock, renderCalling } from '../test/harness.tsx';

/*
 * Integration tests for the call provider + strip, driven through the lead-page
 * launcher. The connect leg runs on an injectable fake clock so the lifecycle is
 * deterministic (no real timers): dialing → ringing → answered, then hang-up →
 * log-outcome lands a call_logged on the shared timeline. Failure paths: a DNC
 * lead cannot be dialed (button disabled + provider surfaces the 422 block), and
 * only one call runs at a time.
 */

function findDialableLead(): { lead: Lead; contact: Contact } {
  for (const lead of db.leads) {
    if (lead.dnc || lead.deletedAt !== null) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && c.phones.length > 0,
    );
    const phone = contact?.phones[0]?.phone;
    if (contact && phone && !contact.dnc && !isPhoneSuppressed(phone)) return { lead, contact };
  }
  throw new Error('fixture has no dialable lead');
}

function findDncLead(): Lead {
  const lead = db.leads.find((l) => l.dnc && l.deletedAt === null);
  if (!lead) throw new Error('fixture has no DNC lead');
  return lead;
}

function timelineCount(leadId: string, type: string): number {
  return (db.activitiesByLead.get(leadId) ?? []).filter((a) => a.type === type).length;
}

beforeEach(() => {
  resetCallsStore();
  server.use(...callingHandlers);
});
afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  cleanup();
});

describe('CallProvider — lifecycle through the launcher', () => {
  test('dials the lead and progresses dialing → ringing → answered, consent shown', async () => {
    const { lead } = findDialableLead();
    const clock = makeFakeClock();
    const user = userEvent.setup();
    renderCalling(
      <CallProvider clock={clock} timings={{ dialMs: 10, ringMs: 10 }}>
        <LeadCallLauncher lead={lead} />
      </CallProvider>,
    );

    await user.click(screen.getByRole('button', { name: /Call/ }));
    await screen.findByText('Dialing…');

    act(() => clock.advance(10));
    await screen.findByText('Ringing…');

    act(() => clock.advance(10));
    await screen.findByText('0:00'); // answered → live duration timer

    // I-REC: recording is on (org default) → the consent line is visible.
    expect(screen.getByText(/Recording/)).toBeInTheDocument();
    expect(screen.getByText(/consent announced/)).toBeInTheDocument();
    // Controls are live once answered.
    expect(screen.getByRole('button', { name: 'Mute' })).toBeEnabled();
  });

  test('hang up → log outcome lands a call_logged on the timeline and closes the strip', async () => {
    const { lead } = findDialableLead();
    const clock = makeFakeClock();
    const user = userEvent.setup();
    renderCalling(
      <CallProvider clock={clock} timings={{ dialMs: 10, ringMs: 10 }}>
        <LeadCallLauncher lead={lead} />
      </CallProvider>,
    );

    await user.click(screen.getByRole('button', { name: /Call/ }));
    await screen.findByText('Dialing…');
    act(() => clock.advance(10));
    act(() => clock.advance(10));
    await screen.findByText('0:00');

    const before = timelineCount(lead.id, 'call_logged');
    await user.click(screen.getByRole('button', { name: /Hang up/ }));

    // Wrap-up: pick an outcome, then log.
    const logBtn = await screen.findByRole('button', { name: 'Log call' });
    expect(logBtn).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Connected' }));
    expect(logBtn).toBeEnabled();
    await user.click(logBtn);

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /Call with/ })).not.toBeInTheDocument(),
    );
    expect(timelineCount(lead.id, 'call_logged')).toBe(before + 1);
  });

  test('the launcher disables Call for a DNC lead (rail visible on the lead page)', () => {
    const lead = findDncLead();
    renderCalling(
      <CallProvider>
        <LeadCallLauncher lead={lead} />
      </CallProvider>,
    );
    const btn = screen.getByRole('button', { name: /Call/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Do not contact');
  });

  test('while a call is live the launcher is disabled — one call at a time', async () => {
    const { lead } = findDialableLead();
    const clock = makeFakeClock();
    const user = userEvent.setup();
    renderCalling(
      <CallProvider clock={clock} timings={{ dialMs: 10, ringMs: 10 }}>
        <LeadCallLauncher lead={lead} />
      </CallProvider>,
    );
    await user.click(screen.getByRole('button', { name: /Call/ }));
    await screen.findByText('Dialing…');
    await waitFor(() => expect(screen.getByRole('button', { name: /Call/ })).toBeDisabled());
  });

  test('a DNC dial via the provider surfaces the block and opens no strip', async () => {
    const lead = findDncLead();
    const user = userEvent.setup();
    function Harness(): JSX.Element {
      const { startCall } = useCall();
      return (
        <button
          type="button"
          onClick={() => void startCall({ leadId: lead.id, leadName: lead.name })}
        >
          force-dial
        </button>
      );
    }
    renderCalling(
      <CallProvider>
        <Harness />
      </CallProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'force-dial' }));
    // The block toast appears and no call strip opens.
    await screen.findByText(/do-not-contact list/);
    expect(screen.queryByRole('region', { name: /Call with/ })).not.toBeInTheDocument();
  });
});
