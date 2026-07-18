import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { useLocation } from 'react-router-dom';
import type { Lead } from '@switchboard/shared';
import { server } from '../../mocks/server.ts';
import { db } from '../../mocks/fixtures.ts';
import { callingHandlers } from './mocks/callingHandlers.ts';
import { isPhoneSuppressed, resetCallsStore } from './data/callsStore.ts';
import { CallProvider, useCall } from './context/CallProvider.tsx';
import { useCallingCommands } from './commands.ts';
import { renderCalling } from './test/harness.tsx';

/*
 * The calling palette commands: "Start list dialer" navigates, and "Call lead…"
 * dials the lead currently in view (the focus target the lead-page launcher sets).
 */

function findDialableLead(): Lead {
  for (const lead of db.leads) {
    if (lead.dnc || lead.deletedAt !== null) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && c.phones.length > 0,
    );
    const phone = contact?.phones[0]?.phone;
    if (contact && phone && !contact.dnc && !isPhoneSuppressed(phone)) return lead;
  }
  throw new Error('fixture has no dialable lead');
}

function LocationLabel(): JSX.Element {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function Harness({ focus }: { focus?: Lead }): JSX.Element {
  const commands = useCallingCommands(() => undefined);
  const { setFocusTarget } = useCall();
  return (
    <div>
      <button
        type="button"
        onClick={() => focus && setFocusTarget({ leadId: focus.id, leadName: focus.name })}
      >
        set-focus
      </button>
      {commands.map((c) => (
        <button key={c.id} type="button" onClick={c.run}>
          {c.title}
        </button>
      ))}
      <LocationLabel />
    </div>
  );
}

beforeEach(() => {
  resetCallsStore();
  server.use(...callingHandlers);
});
afterEach(cleanup);

describe('useCallingCommands', () => {
  test('registers both calling commands', () => {
    renderCalling(
      <CallProvider>
        <Harness />
      </CallProvider>,
    );
    expect(screen.getByRole('button', { name: 'Call lead…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start list dialer' })).toBeInTheDocument();
  });

  test('"Start list dialer" navigates to /dialer', async () => {
    const user = userEvent.setup();
    renderCalling(
      <CallProvider>
        <Harness />
      </CallProvider>,
      { route: '/inbox' },
    );
    expect(screen.getByTestId('path')).toHaveTextContent('/inbox');
    await user.click(screen.getByRole('button', { name: 'Start list dialer' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/dialer');
  });

  test('"Call lead…" dials the focused lead', async () => {
    const lead = findDialableLead();
    const user = userEvent.setup();
    renderCalling(
      <CallProvider timings={{ dialMs: 50, ringMs: 50 }}>
        <Harness focus={lead} />
      </CallProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'set-focus' }));
    await user.click(screen.getByRole('button', { name: 'Call lead…' }));
    expect(
      await screen.findByRole('region', { name: new RegExp(`Call with ${lead.name}`) }),
    ).toBeInTheDocument();
  });
});
