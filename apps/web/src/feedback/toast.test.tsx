import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ToastProvider, useToast } from './ToastProvider.tsx';

afterEach(cleanup);

function Trigger({ message }: { message: string }): ReactNode {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast(message)}>
      fire
    </button>
  );
}

describe('ToastProvider', () => {
  test('shows a message in a polite live region', async () => {
    render(
      <ToastProvider>
        <Trigger message="saved to the timeline" />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'fire' }));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('saved to the timeline');
  });

  test('can be dismissed manually', async () => {
    render(
      <ToastProvider>
        <Trigger message="dismiss me" />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'fire' }));
    expect(screen.getByText('dismiss me')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('dismiss me')).not.toBeInTheDocument();
  });

  test('auto-dismisses after its ttl', async () => {
    render(
      <ToastProvider ttl={40}>
        <Trigger message="fleeting" />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'fire' }));
    expect(screen.getByText('fleeting')).toBeInTheDocument();
    await waitForElementToBeRemoved(() => screen.queryByText('fleeting'));
  });

  test('throws when used outside a provider', () => {
    function Bare(): ReactNode {
      useToast();
      return null;
    }
    // Suppress React's error boundary console noise for the expected throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Bare />)).toThrow('useToast must be used within a ToastProvider');
    spy.mockRestore();
  });
});
