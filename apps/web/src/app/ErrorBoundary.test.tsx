import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { ErrorBoundary } from './ErrorBoundary.tsx';

/*
 * Crash armor. jsdom's location.reload is not implemented, so it is replaced
 * with a spy per test; React's console noise for caught errors is silenced.
 */

const reload = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  reload.mockClear();
  Object.defineProperty(window, 'location', {
    value: { ...window.location, reload },
    writable: true,
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Boom({ message }: { message: string }): JSX.Element {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  test('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  test('a render error shows the recoverable panel; Reload reloads', async () => {
    render(
      <ErrorBoundary>
        <Boom message="ordinary render crash" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a stale-chunk error auto-reloads ONCE — the guard stops a loop', () => {
    // First failure: the deploy replaced the chunk hashes → reload automatically.
    render(
      <ErrorBoundary>
        <Boom message="Failed to fetch dynamically imported module: /assets/chunk-abc.js" />
      </ErrorBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('sb-chunk-reloaded')).toBe('1');
    cleanup();

    // Second failure in the same session: no silent loop — show the panel.
    render(
      <ErrorBoundary>
        <Boom message="Failed to fetch dynamically imported module: /assets/chunk-abc.js" />
      </ErrorBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });
});
