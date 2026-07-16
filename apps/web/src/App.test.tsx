import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App.tsx';

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
});
afterEach(cleanup);

// Full composition smoke: <App/> wires the real BrowserRouter + providers, so an
// unauthenticated boot must land on the dev-login screen with users loaded from
// the mock API.
test('boots unauthenticated into the dev-login screen', async () => {
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /Ada Okafor/ })).toBeInTheDocument();
});
