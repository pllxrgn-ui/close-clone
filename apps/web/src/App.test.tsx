import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App.tsx';

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
});
afterEach(cleanup);

// Full composition smoke: <App/> wires the real BrowserRouter + providers. Bare
// `/` is the front door — an unauthenticated boot lands on the Welcome landing
// (RootGate), not a login wall; the app itself stays behind /login for deep links.
test('boots unauthenticated into the Welcome landing', async () => {
  render(<App />);
  expect(await screen.findByRole('heading', { name: /Pick up the line/ })).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Open Switchboard' }).length).toBeGreaterThan(0);
});

// Deep links keep the auth gate: an unauthenticated /inbox visit goes to the
// dev-login screen with users loaded from the mock API.
test('unauthenticated deep link still lands on the dev-login screen', async () => {
  window.history.pushState({}, '', '/inbox');
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /Ada Okafor/ })).toBeInTheDocument();
});
