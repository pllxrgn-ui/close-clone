import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { isInboundOptOut } from '../lib/sms.ts';
import { messagesForLead, resetSmsStore, smsStore } from '../data/store.ts';
import { smsHandlers } from '../mocks/smsHandlers.ts';
import { SmsConversationDrawer } from './SmsConversationDrawer.tsx';
import { renderSms } from '../test/harness.tsx';

/*
 * The conversation drawer end to end against the shared MSW server: the thread
 * renders inbound-left / outbound-right, a send appends a new outbound bubble, an
 * opted-out thread shows the STOP divider + blocks the composer, and a lead with no
 * history gets the empty state.
 */

const WITHIN = new Date('2026-07-15T17:00:00.000Z'); // 10am PT — inside the window

interface LeadFacts {
  hasIn: boolean;
  hasOut: boolean;
  hasStop: boolean;
}

function factsByLead(): Map<string, LeadFacts> {
  const map = new Map<string, LeadFacts>();
  for (const m of smsStore.messages) {
    const f = map.get(m.leadId) ?? { hasIn: false, hasOut: false, hasStop: false };
    if (m.direction === 'inbound') {
      f.hasIn = true;
      if (isInboundOptOut(m.body)) f.hasStop = true;
    } else {
      f.hasOut = true;
    }
    map.set(m.leadId, f);
  }
  return map;
}

/** First lead with a two-sided, non-opted-out conversation. */
function activeThreadLeadId(): string {
  for (const [leadId, f] of factsByLead()) {
    if (f.hasIn && f.hasOut && !f.hasStop) return leadId;
  }
  throw new Error('no seeded two-sided thread');
}

function optedOutLeadId(): string {
  for (const [leadId, f] of factsByLead()) if (f.hasStop) return leadId;
  throw new Error('no seeded opted-out thread');
}

function emptyLeadId(): string {
  const lead = db.leads.find(
    (l) => !l.dnc && l.deletedAt === null && messagesForLead(l.id).length === 0,
  );
  if (!lead) throw new Error('no lead without a thread');
  return lead.id;
}

beforeEach(() => {
  resetSmsStore();
  server.use(...smsHandlers);
});
afterEach(() => {
  resetSmsStore();
  cleanup();
});

describe('SmsConversationDrawer', () => {
  test('renders the thread with inbound (left) and outbound (right) bubbles', async () => {
    const leadId = activeThreadLeadId();
    const seeded = messagesForLead(leadId);
    const inbound = seeded.find((m) => m.direction === 'inbound' && !isInboundOptOut(m.body));
    const outbound = seeded.find((m) => m.direction === 'outbound');

    renderSms(<SmsConversationDrawer open leadId={leadId} onClose={() => {}} now={WITHIN} />);

    await screen.findByText(inbound!.body);
    expect(screen.getByText(outbound!.body)).toBeInTheDocument();
    // Sidedness: inbound bubbles left, outbound right.
    expect(document.querySelectorAll('.sms-bubble--in').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.sms-bubble--out').length).toBeGreaterThan(0);
    // The conversation region is a log for screen readers.
    expect(screen.getByRole('log', { name: 'SMS conversation' })).toBeInTheDocument();
  });

  test('sending appends a new outbound bubble to the thread', async () => {
    const user = userEvent.setup();
    const leadId = activeThreadLeadId();
    renderSms(<SmsConversationDrawer open leadId={leadId} onClose={() => {}} now={WITHIN} />);

    await screen.findByRole('log', { name: 'SMS conversation' });
    await user.type(screen.getByLabelText('Message body'), 'Fresh outbound line');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Fresh outbound line')).toBeInTheDocument();
  });

  test('an opted-out thread shows the STOP divider and blocks the composer', async () => {
    const leadId = optedOutLeadId();
    renderSms(<SmsConversationDrawer open leadId={leadId} onClose={() => {}} now={WITHIN} />);

    await screen.findByText(/opted out and suppressed/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/replied STOP/i);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  test('a lead with no history shows the empty state', async () => {
    renderSms(
      <SmsConversationDrawer open leadId={emptyLeadId()} onClose={() => {}} now={WITHIN} />,
    );
    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
  });
});
