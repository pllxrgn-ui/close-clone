import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server.ts';
import { aiHandlers } from './mocks/aiHandlers.ts';
import { aiStore, resetAiStore } from './data/store.ts';
import { AiDraftControl } from './components/AiDraftControl.tsx';
import { AiSmartViewModal } from './components/AiSmartViewModal.tsx';
import { LeadCallSummaries } from './components/LeadCallSummaries.tsx';
import { api, makeCall, makeUser, renderAi, signInAs, signOut } from './test/harness.tsx';

/*
 * axe-core structural smoke for the AI surfaces, under both themes. Color-contrast
 * can't run in jsdom (the AA pairs are verified statically in tokens.css), so we fail
 * only on serious/critical — matching the comms/leads acceptance bar.
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

beforeEach(() => {
  resetAiStore();
  signInAs(makeUser());
  server.use(...aiHandlers);
  document.documentElement.lang = 'en';
});
afterEach(() => {
  signOut();
  document.documentElement.removeAttribute('data-theme');
  cleanup();
});

describe('ai a11y', () => {
  test('NL→Smart View modal has no serious/critical violations (light + dark)', async () => {
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const { unmount } = renderAi(<AiSmartViewModal open onClose={() => {}} />);
      await screen.findByLabelText(/describe the view/i);
      // Let the async field-catalog query settle so its state update is inside act.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await expectNoSeriousViolations(document.body);
      unmount();
    }
  });

  test('composer draft control (open panel) has no serious/critical violations', async () => {
    const user = userEvent.setup();
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const { container, unmount } = renderAi(
        <AiDraftControl subject="Intro" body="" onApply={() => {}} />,
      );
      await user.click(screen.getByRole('button', { name: /draft with ai/i }));
      await screen.findByLabelText(/what should the ai write/i);
      await expectNoSeriousViolations(container);
      unmount();
    }
  });

  test('lead call summaries (draft shown) has no serious/critical violations', async () => {
    const user = userEvent.setup();
    const call = makeCall({ id: '44444444-4444-4444-8444-444444444444', leadId: 'La11y' });
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      resetAiStore();
      aiStore.calls.push(call);
      aiStore.transcripts.set(call.id, 'They asked us to send a revised quote next week.');
      server.use(http.get(api('/calls'), () => HttpResponse.json([call])));

      const { container, unmount } = renderAi(<LeadCallSummaries leadId="La11y" />);
      await user.click(await screen.findByRole('button', { name: /summarize/i }));
      await screen.findByText(/ai draft/i);
      await expectNoSeriousViolations(container);
      unmount();
    }
  });
});
