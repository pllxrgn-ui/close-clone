import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App.tsx';

afterEach(cleanup);

test('renders the Switchboard app shell', () => {
  render(<App />);
  const heading = screen.getByRole('heading', { level: 1 });
  expect(heading.textContent).toBe('Switchboard');
});
