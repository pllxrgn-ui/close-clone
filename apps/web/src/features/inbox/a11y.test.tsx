import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { server } from '../../mocks/server.ts';
import { inboxHandlers } from './mocks/inboxHandlers.ts';
import { loadInboxStore, resetInboxStore } from './model/store.ts';
import { makeReview, makeStore, makeTask, makeThread, renderInbox } from './test/harness.tsx';

/*
 * axe-core structural smoke for the Inbox. color-contrast can't run in jsdom (the
 * AA pairs are verified statically in tokens.css), so we fail only on serious/
 * critical violations, matching the W1/W3 bar, and run under both themes. This is
 * also the guard on the surface's a11y structure: a focusable row body (the J/K
 * target) with pointer/`?`-driven action buttons, no nested interactive controls.
 */

const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };

async function expectNoSeriousViolations(root: HTMLElement): Promise<void> {
  const results = await axe.run(root, AXE_OPTIONS);
  expect(results.passes.length).toBeGreaterThan(0);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const summary = blocking.map((v) => `${v.id} (${String(v.impact)}): ${v.help}`).join('\n');
  expect(summary).toBe('');
}

function richStore(): void {
  loadInboxStore(
    makeStore({
      threads: [makeThread({ id: 'r1' })],
      tasks: [makeTask({ id: 't1', leadId: 'L2' }), makeTask({ id: 't2', leadId: 'L3' })],
      reviews: [makeReview({ id: 'v1', leadId: 'L4' })],
      leadNames: [
        ['L1', 'North Labs'],
        ['L2', 'Cedar Systems'],
        ['L3', 'Iron Foods'],
        ['L4', 'Blue Media'],
      ],
      leadDnc: [
        ['L1', false],
        ['L2', true], // renders the DNC pill on a task row
        ['L3', false],
        ['L4', false],
      ],
    }),
  );
}

beforeEach(() => {
  resetInboxStore();
  server.use(...inboxHandlers);
  document.documentElement.lang = 'en';
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

describe('inbox surface — axe', () => {
  test('the merged queue has no serious/critical violations (light + dark)', async () => {
    for (const theme of ['light', 'dark'] as const) {
      richStore();
      document.documentElement.dataset.theme = theme;
      const { container, unmount } = renderInbox();
      await screen.findAllByRole('button', { name: /^Complete task for/ });
      await expectNoSeriousViolations(container);
      unmount();
    }
  });

  test('the composer drawer has no serious/critical violations', async () => {
    loadInboxStore(makeStore({ threads: [makeThread({ id: 'r1' })] }));
    const user = userEvent.setup();
    document.documentElement.dataset.theme = 'dark';
    renderInbox();
    await user.click(await screen.findByRole('button', { name: 'Reply to North Labs' }));
    await screen.findByRole('dialog', { name: 'Reply to North Labs' });
    // The drawer is portalled to <body>, so scan the whole document.
    await expectNoSeriousViolations(document.body);
  });

  test('the zero-inbox state has no serious/critical violations', async () => {
    loadInboxStore(makeStore({}));
    document.documentElement.dataset.theme = 'light';
    const { container } = renderInbox();
    await screen.findByText(/all caught up/i);
    await expectNoSeriousViolations(container);
  });
});
