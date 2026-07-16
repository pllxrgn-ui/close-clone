import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import * as axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server.ts';
import { commsHandlers } from './mocks/commsHandlers.ts';
import { commsStore, resetCommsStore } from './data/store.ts';
import { Composer } from './components/Composer.tsx';
import { SequencesList } from './components/SequencesList.tsx';
import { SequenceDetail } from './components/SequenceDetail.tsx';
import {
  api,
  makeContact,
  makeLead,
  makeTemplate,
  makeUser,
  renderComms,
} from './test/harness.tsx';

/*
 * axe-core structural smoke for the comms surfaces, under both themes. Color-
 * contrast can't run in jsdom (the AA pairs are verified statically in tokens.css),
 * so we fail only on serious/critical — matching the W1/leads acceptance bar.
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

function stubComposer(): void {
  server.use(
    http.get(api('/leads/:id'), () => HttpResponse.json(makeLead())),
    http.get(api('/contacts'), () =>
      HttpResponse.json([makeContact({ emails: [{ email: 'sam@x.com', type: 'work' }] })]),
    ),
    http.get(api('/users'), () => HttpResponse.json([makeUser()])),
    http.get(api('/templates'), () => HttpResponse.json([makeTemplate()])),
    http.get(api('/snippets'), () => HttpResponse.json([])),
    http.get(api('/emails/suppressed-recipients'), () => HttpResponse.json({ emails: [] })),
  );
}

function onboardingId(): string {
  const seq = commsStore.sequences.find((s) => s.name === 'Onboarding');
  if (!seq) throw new Error('Onboarding sequence missing from seed');
  return seq.id;
}

beforeEach(() => {
  resetCommsStore();
  server.use(...commsHandlers);
  document.documentElement.lang = 'en';
});
afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  cleanup();
});

describe('comms a11y', () => {
  test('composer drawer has no serious/critical violations (light + dark)', async () => {
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      stubComposer();
      const { unmount } = renderComms(<Composer open onClose={() => {}} leadId="L1" />);
      await screen.findByLabelText('Subject');
      await expectNoSeriousViolations(document.body);
      unmount();
    }
  });

  test('sequences list has no serious/critical violations (light + dark)', async () => {
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const { container, unmount } = renderComms(<SequencesList />, '/sequences');
      await screen.findByRole('button', { name: /Onboarding/ });
      await expectNoSeriousViolations(container);
      unmount();
    }
  });

  test('sequence detail has no serious/critical violations (light + dark)', async () => {
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const { container, unmount } = renderComms(
        <SequenceDetail sequenceId={onboardingId()} />,
        '/sequences/x',
      );
      await screen.findByRole('heading', { name: 'Onboarding', level: 1 });
      await screen.findAllByText('Needs review');
      await expectNoSeriousViolations(container);
      unmount();
    }
  });
});
