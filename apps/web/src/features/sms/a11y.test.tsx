import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import * as axe from 'axe-core';
import { server } from '../../mocks/server.ts';
import { isInboundOptOut } from './lib/sms.ts';
import { resetSmsStore, smsStore } from './data/store.ts';
import { smsHandlers } from './mocks/smsHandlers.ts';
import { SmsConversationDrawer } from './components/SmsConversationDrawer.tsx';
import { renderSms } from './test/harness.tsx';

/*
 * axe-core structural smoke for the SMS drawer, under both themes. Color-contrast
 * cannot run in jsdom (the AA pairs are verified statically in tokens.css), so we
 * fail only on serious/critical — matching the comms/leads acceptance bar.
 */

const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };
const THEMES = ['light', 'dark'] as const;
const WITHIN = new Date('2026-07-15T17:00:00.000Z');

async function expectNoSeriousViolations(root: HTMLElement): Promise<void> {
  const results = await axe.run(root, AXE_OPTIONS);
  expect(results.passes.length).toBeGreaterThan(0);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(blocking.map((v) => `${v.id} (${String(v.impact)}): ${v.help}`).join('\n')).toBe('');
}

function anyThreadLeadId(): string {
  const first = smsStore.messages.find((m) => m.direction === 'outbound');
  if (!first) throw new Error('no seeded thread');
  return first.leadId;
}

function optedOutLeadId(): string {
  const stop = smsStore.messages.find((m) => m.direction === 'inbound' && isInboundOptOut(m.body));
  if (!stop) throw new Error('no opted-out thread');
  return stop.leadId;
}

beforeEach(() => {
  resetSmsStore();
  server.use(...smsHandlers);
  document.documentElement.lang = 'en';
});
afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  cleanup();
});

describe('sms a11y', () => {
  test('conversation drawer has no serious/critical violations (light + dark)', async () => {
    const leadId = anyThreadLeadId();
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const { unmount } = renderSms(
        <SmsConversationDrawer open leadId={leadId} onClose={() => {}} now={WITHIN} />,
      );
      await screen.findByRole('log', { name: 'SMS conversation' });
      await expectNoSeriousViolations(document.body);
      unmount();
    }
  });

  test('the opted-out blocked state has no serious/critical violations (light + dark)', async () => {
    const leadId = optedOutLeadId();
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const { unmount } = renderSms(
        <SmsConversationDrawer open leadId={leadId} onClose={() => {}} now={WITHIN} />,
      );
      await screen.findByText(/opted out and suppressed/i);
      await expectNoSeriousViolations(document.body);
      unmount();
    }
  });
});
