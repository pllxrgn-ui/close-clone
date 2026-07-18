import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contact, Lead } from '@switchboard/shared';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { messagesForLead, resetSmsStore, smsStore } from '../data/store.ts';
import { phoneMatchKey } from '../lib/sms.ts';
import { smsHandlers } from '../mocks/smsHandlers.ts';
import { SmsComposer } from './SmsComposer.tsx';
import { makeContact, makeLead, makeSms, renderSms } from '../test/harness.tsx';

/*
 * The compliance-gated composer: every §C6 rail is surfaced before Send, the §4.5
 * first-contact opt-out language is shown before it is sent, and a successful send
 * reaches the real `POST /sms/send` shape.
 */

const WITHIN = new Date('2026-07-15T17:00:00.000Z'); // 10am PT — inside 8am–9pm

/** A real, sendable fixture lead+contact (non-DNC, phone present, not suppressed). */
function sendableFixture(): { lead: Lead; contact: Contact } {
  for (const lead of db.leads) {
    if (lead.dnc || lead.deletedAt !== null) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && !c.dnc && c.phones[0]?.phone,
    );
    const phone = contact?.phones[0]?.phone;
    if (contact && phone && !smsStore.suppressedNumbers.has(phoneMatchKey(phone))) {
      return { lead, contact };
    }
  }
  throw new Error('fixture has no sendable lead');
}

beforeEach(() => {
  resetSmsStore();
  server.use(...smsHandlers);
});
afterEach(() => {
  resetSmsStore();
  cleanup();
});

function noop(): void {}

describe('SmsComposer — counter + templates + opt-out preview', () => {
  test('shows a live character/segment counter and the first-contact opt-out preview', async () => {
    const user = userEvent.setup();
    renderSms(
      <SmsComposer
        leadId="L1"
        lead={makeLead()}
        contact={makeContact()}
        messages={[]}
        now={WITHIN}
        onSent={noop}
      />,
    );

    await user.type(screen.getByLabelText('Message body'), 'Hi there');
    // Fresh number, no prior outbound → §4.5 opt-out language is shown appended.
    expect(screen.getByText('Auto-appended')).toBeInTheDocument();
    expect(screen.getByText('Reply STOP to unsubscribe.')).toBeInTheDocument();
    expect(screen.getByText(/\d+ chars · 1 SMS/)).toBeInTheDocument();
  });

  test('does not preview opt-out language when the body already carries it', async () => {
    const user = userEvent.setup();
    renderSms(
      <SmsComposer
        leadId="L1"
        lead={makeLead()}
        contact={makeContact()}
        messages={[]}
        now={WITHIN}
        onSent={noop}
      />,
    );
    await user.type(screen.getByLabelText('Message body'), 'Ping — reply STOP anytime');
    expect(screen.queryByText('Auto-appended')).not.toBeInTheDocument();
  });

  test('applying an SMS template fills the body', async () => {
    const user = userEvent.setup();
    renderSms(
      <SmsComposer
        leadId="L1"
        lead={makeLead()}
        contact={makeContact()}
        messages={[]}
        now={WITHIN}
        onSent={noop}
      />,
    );
    await user.selectOptions(screen.getByLabelText('SMS template'), 'sms-intro');
    expect((screen.getByLabelText('Message body') as HTMLTextAreaElement).value).toMatch(
      /booked a demo/,
    );
  });
});

describe('SmsComposer — compliance rails disable Send (I-DNC / I-QUIET)', () => {
  test('blocks a DNC lead with a visible reason', () => {
    renderSms(
      <SmsComposer
        leadId="L1"
        lead={makeLead({ dnc: true })}
        contact={makeContact()}
        messages={[]}
        now={WITHIN}
        onSent={noop}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/do-not-contact/i);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  test('blocks a DNC contact', () => {
    renderSms(
      <SmsComposer
        leadId="L1"
        lead={makeLead()}
        contact={makeContact({ dnc: true })}
        messages={[]}
        now={WITHIN}
        onSent={noop}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/contact is marked do-not-contact/i);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  test('blocks an opted-out (STOP) number', () => {
    const stop = makeSms({ direction: 'inbound', body: 'STOP' });
    renderSms(
      <SmsComposer
        leadId="L1"
        lead={makeLead()}
        contact={makeContact()}
        messages={[stop]}
        now={WITHIN}
        onSent={noop}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/replied STOP/i);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  test('blocks a send outside the 8am–9pm recipient window (I-QUIET)', () => {
    const night = new Date('2026-07-15T06:00:00.000Z'); // 11pm PT for a +1206 number
    renderSms(
      <SmsComposer
        leadId="L1"
        lead={makeLead()}
        contact={makeContact()}
        messages={[]}
        now={night}
        onSent={noop}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Outside the 8am–9pm window/i);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  test('disables Send when the contact has no phone number', () => {
    renderSms(
      <SmsComposer
        leadId="L1"
        lead={makeLead()}
        contact={makeContact({ phones: [] })}
        messages={[]}
        now={WITHIN}
        onSent={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText(/Add a phone number/i)).toBeInTheDocument();
  });
});

describe('SmsComposer — successful send', () => {
  test('sends via POST /sms/send, appends to the store, clears the draft', async () => {
    const user = userEvent.setup();
    const { lead, contact } = sendableFixture();
    let sent = 0;
    renderSms(
      <SmsComposer
        leadId={lead.id}
        lead={lead}
        contact={contact}
        messages={messagesForLead(lead.id)}
        now={WITHIN}
        onSent={() => {
          sent += 1;
        }}
      />,
    );

    const before = messagesForLead(lead.id).length;
    const box = screen.getByLabelText('Message body');
    await user.type(box, 'Sending a real one');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(messagesForLead(lead.id).length).toBe(before + 1));
    expect(sent).toBe(1);
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });
});
