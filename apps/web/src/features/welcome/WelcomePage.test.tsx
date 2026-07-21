import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RenderResult } from '@testing-library/react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as axe from 'axe-core';
import { AppProviders } from '../../app/AppProviders.tsx';
import { ROUTER_FUTURE } from '../../app/routerFuture.ts';
import { THEME_STORAGE_KEY } from '../../theme/theme.ts';
import { WelcomePage } from './WelcomePage.tsx';
import { IGNITION_SESSION_KEY } from './useIgnition.ts';

/* Mount the landing page as it will be wired: a real /welcome route with the
 * app providers around it. A /login stub stands in for the dev-login gate the
 * CTAs point at. */
function renderWelcome(): RenderResult {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={['/welcome']} future={ROUTER_FUTURE}>
        <Routes>
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/login" element={<h1>Dev login</h1>} />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

/** Point matchMedia at a fixed reduced-motion answer for this test. */
function stubReducedMotion(matches: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string): MediaQueryList => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, AXE_OPTIONS);
  expect(results.passes.length).toBeGreaterThan(0);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const summary = blocking.map((v) => `${v.id} (${String(v.impact)}): ${v.help}`).join('\n');
  expect(summary).toBe('');
}

function hero(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.sb-welcome__hero');
  if (!el) throw new Error('hero not found');
  return el;
}

beforeAll(() => {
  document.documentElement.lang = 'en';
  document.title = 'Switchboard';
});
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(cleanup);

describe('WelcomePage — hero frame + nav menu + accounts band', () => {
  test('nav anchors point at real sections on the page', () => {
    const { container } = renderWelcome();
    for (const [name, target] of [
      ['Features', 'welcome-acts'],
      ['Shortcuts', 'welcome-keys'],
      ['Compliance', 'welcome-trust'],
    ] as const) {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveAttribute('href', `#${target}`);
      expect(container.querySelector(`#${target}`)).not.toBeNull();
    }
  });

  test('the mobile menu toggle drives aria-expanded and the open state', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    renderWelcome();
    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Close menu' })).toBe(toggle);
    // Choosing an anchor closes the panel.
    await userEvent.click(screen.getByRole('link', { name: 'Features' }));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('the hero product frame is live DOM, decorative, and shows the triage rows', () => {
    const { container } = renderWelcome();
    const frame = container.querySelector('.sb-welcome__frame-wrap');
    expect(frame).not.toBeNull();
    expect(frame).toHaveAttribute('aria-hidden', 'true');
    expect(frame?.querySelectorAll('.sb-welcome__frame-row')).toHaveLength(5);
    expect(frame?.textContent).toContain('Northwind Labs');
    expect(frame?.querySelector('img')).toBeNull();
  });

  test('the accounts band lists demo accounts as text wordmarks (no logos)', () => {
    const { container } = renderWelcome();
    const band = screen.getByRole('region', { name: 'On the board this week' });
    expect(band.querySelectorAll('li')).toHaveLength(9);
    expect(band.textContent).toContain('Harbor Analytics');
    expect(container.querySelectorAll('.sb-welcome__accounts img')).toHaveLength(0);
  });
});

describe('WelcomePage — route + content', () => {
  test('explains the connected workflow in three steps', () => {
    const { container } = renderWelcome();
    expect(
      screen.getByRole('heading', { name: 'From connected inbox to completed follow-up' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Connect your Gmail inbox')).toBeInTheDocument();
    expect(screen.getByText('Work the next signal')).toBeInTheDocument();
    expect(screen.getByText('Keep every touch together')).toBeInTheDocument();
    expect(container.querySelectorAll('.sb-welcome__workflow-step')).toHaveLength(3);
  });

  test('the Workflow anchor points at the real section', () => {
    const { container } = renderWelcome();
    expect(screen.getByRole('link', { name: 'Workflow' })).toHaveAttribute(
      'href',
      '#welcome-workflow',
    );
    expect(container.querySelector('#welcome-workflow')).not.toBeNull();
  });

  test('renders at /welcome with the headline, sub, and stat readout', () => {
    renderWelcome();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Pick up the line.');
    expect(screen.getByText(/one keystroke away/i)).toBeInTheDocument();
    expect(screen.getByText('0.9s')).toBeInTheDocument();
    expect(screen.getByText('to the next call')).toBeInTheDocument();
  });

  test('both CTAs and the nav sign-in point at the dev-login gate', () => {
    renderWelcome();
    const openLinks = screen.getAllByRole('link', { name: /open switchboard/i });
    expect(openLinks).toHaveLength(2); // hero + footer
    for (const link of openLinks) {
      expect(link).toHaveAttribute('href', '/login');
    }
    expect(screen.getByRole('link', { name: /sign in · sso/i })).toHaveAttribute('href', '/login');
  });

  test('shows the six state lamps and the three feature acts', () => {
    renderWelcome();
    for (const word of ['Reply', 'Live', 'Sequence', 'Overdue', 'Do not contact', 'Idle']) {
      expect(screen.getAllByText(word).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Inbox triage')).toBeInTheDocument();
    expect(screen.getByText('One-keystroke calling')).toBeInTheDocument();
    expect(screen.getByText('Sequences that stop themselves')).toBeInTheDocument();
  });

  test('renders the real keyboard map (command palette + a nav chord)', () => {
    renderWelcome();
    expect(screen.getByText('Command palette')).toBeInTheDocument();
    // The nav chords are derived from the shell nav, e.g. Inbox → g i.
    const inboxRows = screen.getAllByText('Inbox');
    expect(inboxRows.length).toBeGreaterThan(0);
  });

  test('states the compliance trust line', () => {
    renderWelcome();
    expect(screen.getByText(/DNC enforced at the engine/i)).toBeInTheDocument();
    expect(screen.getByText(/Consent announced on every recorded call/i)).toBeInTheDocument();
  });
});

describe('WelcomePage — all live DOM', () => {
  test('contains no <img> elements (no screenshots or stock)', () => {
    const { container } = renderWelcome();
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('WelcomePage — ignition', () => {
  test('a fresh, motion-allowed visit ignites the board once', () => {
    stubReducedMotion(false);
    const { container } = renderWelcome();
    expect(hero(container)).toHaveAttribute('data-ignite', 'igniting');
    // The session flag is burned so a later mount cannot re-ignite.
    expect(sessionStorage.getItem(IGNITION_SESSION_KEY)).toBe('1');
  });

  test('a second visit in the same session does not re-ignite (replay guard)', () => {
    stubReducedMotion(false);
    const first = renderWelcome();
    expect(hero(first.container)).toHaveAttribute('data-ignite', 'igniting');
    cleanup();
    const second = renderWelcome();
    expect(hero(second.container)).toHaveAttribute('data-ignite', 'lit');
  });

  test('reduced motion collapses ignition to instant (lit, no replay flag)', () => {
    stubReducedMotion(true);
    const { container } = renderWelcome();
    expect(hero(container)).toHaveAttribute('data-ignite', 'lit');
    expect(sessionStorage.getItem(IGNITION_SESSION_KEY)).toBeNull();
  });
});

describe('WelcomePage — themes + a11y', () => {
  test('participates in the theme system under a dark override', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    renderWelcome();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Pick up the line.');
  });

  test('participates in the theme system under a light override', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    renderWelcome();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  test('has no serious or critical axe violations', async () => {
    const { container } = renderWelcome();
    await expectNoSeriousViolations(container);
  });
});
