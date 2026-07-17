import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { db } from '../mocks/fixtures.ts';
import { renderRoutes } from '../test/renderRoutes.tsx';
import { browserNav, SSO_LOGIN_PATH } from './browserNav.ts';

const [USER] = db.users;
if (!USER) throw new Error('fixtures must include at least one user');

/*
 * The login screen is the one place the web branches on API mode (mirroring
 * main.tsx): MOCK keeps the fixture picker, REAL must hand off to the API's
 * OIDC route. Both branches are asserted here — including that real mode never
 * leaks fixture identities or a password field (there is no password store).
 */

// Mirror index.html so page-level axe rules reflect production, not jsdom bare defaults.
beforeAll(() => {
  document.documentElement.lang = 'en';
  document.title = 'Switchboard';
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const AXE_OPTIONS: axe.RunOptions = {
  // jsdom has no layout engine — contrast is verified statically in tokens.css.
  rules: { 'color-contrast': { enabled: false } },
};

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, AXE_OPTIONS);
  expect(results.passes.length).toBeGreaterThan(0);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(blocking.map((v) => `${v.id} (${String(v.impact)}): ${v.help}`).join('\n')).toBe('');
}

describe('LoginPage — mock mode (VITE_API_MODE unset)', () => {
  beforeEach(() => vi.stubEnv('VITE_API_MODE', ''));

  test('renders the dev fixture picker', async () => {
    renderRoutes('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(await screen.findByRole('button', { name: new RegExp(USER.name) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /single sign-on/i })).not.toBeInTheDocument();
  });

  test('picking a user signs in and lands on the requested route', async () => {
    renderRoutes('/login');
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(USER.name) }));
    expect(await screen.findByRole('heading', { name: 'Inbox', level: 1 })).toBeInTheDocument();
  });
});

describe('LoginPage — real mode (VITE_API_MODE=real)', () => {
  beforeEach(() => vi.stubEnv('VITE_API_MODE', 'real'));

  test('renders the SSO screen and no fixture identities or password field', async () => {
    renderRoutes('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.getByRole('button', { name: /single sign-on/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(USER.name) })).not.toBeInTheDocument();
    expect(screen.queryByText(USER.email)).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });

  test('clicking SSO navigates the browser to the API OIDC login route', async () => {
    const assign = vi.spyOn(browserNav, 'assign').mockImplementation(() => undefined);
    renderRoutes('/login');
    await userEvent.click(await screen.findByRole('button', { name: /single sign-on/i }));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/api/v1/auth/login');
    expect(SSO_LOGIN_PATH).toBe('/api/v1/auth/login');
  });

  // failure path: the API bounces denials back to /login?error=<reason>
  test('surfaces a callback denial reason from the query string', async () => {
    renderRoutes('/login?error=no_access');
    expect(await screen.findByRole('alert')).toHaveTextContent(/grant you access to Switchboard/i);
    expect(screen.getByRole('button', { name: /single sign-on/i })).toBeInTheDocument();
  });

  // failure path: an unknown/garbage reason still reports, never renders raw junk as copy
  test('falls back to a generic message for an unrecognized error reason', async () => {
    renderRoutes('/login?error=%3Cscript%3Ewat');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn’t be completed/i);
    expect(alert.textContent).not.toContain('<script>');
  });

  test('an existing session skips the SSO screen', async () => {
    renderRoutes('/login', { user: USER });
    expect(await screen.findByRole('heading', { name: 'Inbox', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /single sign-on/i })).not.toBeInTheDocument();
  });

  test('the SSO screen has no serious/critical axe violations', async () => {
    const { container } = renderRoutes('/login?error=no_access');
    await screen.findByRole('heading', { name: 'Sign in' });
    await expectNoSeriousViolations(container);
  });
});
