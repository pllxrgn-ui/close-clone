import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import * as axe from 'axe-core';
import { db } from '../mocks/fixtures.ts';
import { renderRoutes } from '../test/renderRoutes.tsx';

const [USER] = db.users;
if (!USER) throw new Error('fixtures must include at least one user');

/*
 * axe-core structural smoke test. jsdom has no layout engine, so the
 * color-contrast check can't run here — the AA contrast pairs are instead
 * verified statically (the table in styles/tokens.css). Every other rule
 * (accessible names, roles, ARIA, landmarks, nested-interactive) runs normally.
 * We fail on serious/critical impact only, per the W1 acceptance criterion.
 */
const AXE_OPTIONS: axe.RunOptions = {
  rules: { 'color-contrast': { enabled: false } },
};

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, AXE_OPTIONS);
  // Guard against a vacuous pass: axe must have actually evaluated rules.
  expect(results.passes.length).toBeGreaterThan(0);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const summary = blocking.map((v) => `${v.id} (${String(v.impact)}): ${v.help}`).join('\n');
  expect(summary).toBe('');
}

// Mirror the real document (index.html ships <html lang> + <title>) so page-level
// rules reflect production rather than jsdom's bare defaults.
beforeAll(() => {
  document.documentElement.lang = 'en';
  document.title = 'Switchboard';
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('accessibility smoke (axe-core)', () => {
  test('the authenticated shell has no serious/critical violations', async () => {
    const { container } = renderRoutes('/inbox', { user: USER });
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });
    await expectNoSeriousViolations(container);
  });

  test('the dev-login screen has no serious/critical violations', async () => {
    const { container } = renderRoutes('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    await screen.findByRole('button', { name: new RegExp(USER.name) });
    await expectNoSeriousViolations(container);
  });
});
