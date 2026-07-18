import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import * as axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server.ts';
import { callingHandlers, type DialerEntry } from './mocks/callingHandlers.ts';
import { resetCallsStore } from './data/callsStore.ts';
import { CallProvider, type CallSession } from './context/CallProvider.tsx';
import { CallStrip } from './components/CallStrip.tsx';
import { ListDialer } from './pages/ListDialer.tsx';
import { api, makeFakeClock, renderCalling } from './test/harness.tsx';

/*
 * axe-core structural smoke for the calling surfaces, under both themes. Color-
 * contrast can't run in jsdom (the AA pairs are verified statically in tokens.css),
 * so we fail only on serious/critical — matching the comms/leads acceptance bar.
 */

const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };
const THEMES = ['light', 'dark'] as const;

async function expectNoSeriousViolations(root: HTMLElement): Promise<void> {
  const results = await axe.run(root, AXE_OPTIONS);
  expect(results.passes.length).toBeGreaterThan(0);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(blocking.map((v) => `${v.id} (${String(v.impact)}): ${v.help}`).join('\n')).toBe('');
}

function session(over: Partial<CallSession> = {}): CallSession {
  return {
    callId: 'call-1',
    callSid: 'CA1',
    leadId: 'L1',
    contactId: 'c1',
    leadName: 'North Labs',
    contactName: 'Sam Patel',
    number: '+12065550134',
    recording: true,
    uiState: 'answered',
    answeredAtMs: 0,
    endedAtMs: null,
    muted: false,
    onHold: false,
    voicemailDropped: false,
    via: 'dial',
    ...over,
  };
}

function noop() {
  return {
    onToggleMute: () => undefined,
    onToggleHold: () => undefined,
    onHangUp: () => undefined,
    onDiscard: () => undefined,
    onSaveOutcome: () => Promise.resolve(true),
    onDropVoicemail: () => Promise.resolve(true),
  };
}

const queue: DialerEntry[] = [
  {
    leadId: 'a',
    leadName: 'Apex Labs',
    contactId: null,
    phone: '+12065550111',
    dnc: false,
    suppressed: false,
    dialable: true,
  },
  {
    leadId: 'b',
    leadName: 'Bright Systems',
    contactId: null,
    phone: '+12065550122',
    dnc: true,
    suppressed: false,
    dialable: false,
  },
];

beforeEach(() => {
  resetCallsStore();
  server.use(...callingHandlers);
  document.documentElement.lang = 'en';
});
afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  cleanup();
});

describe('calling a11y', () => {
  test('the call strip (answered) has no serious/critical violations (light + dark)', async () => {
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const { unmount } = renderCalling(
        <CallStrip session={session()} clock={makeFakeClock()} {...noop()} />,
      );
      await screen.findByRole('region', { name: /Call with/ });
      await expectNoSeriousViolations(document.body);
      unmount();
    }
  });

  test('the call strip wrap-up panel has no serious/critical violations (light + dark)', async () => {
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const { unmount } = renderCalling(
        <CallStrip
          session={session({ uiState: 'wrapup', endedAtMs: 5000 })}
          clock={makeFakeClock()}
          {...noop()}
        />,
      );
      await screen.findByRole('button', { name: 'Log call' });
      await expectNoSeriousViolations(document.body);
      unmount();
    }
  });

  test('the list dialer has no serious/critical violations (light + dark)', async () => {
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      server.use(http.post(api('/calls/dialer/queue'), () => HttpResponse.json({ items: queue })));
      const { container, unmount } = renderCalling(
        <CallProvider>
          <ListDialer />
        </CallProvider>,
        { route: '/dialer' },
      );
      await screen.findByTestId('dialer-ondeck');
      await expectNoSeriousViolations(container);
      unmount();
    }
  });
});
