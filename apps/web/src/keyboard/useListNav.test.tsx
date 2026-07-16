import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { KeyboardProvider } from './KeyboardProvider.tsx';
import { useListNav } from './useListNav.ts';

afterEach(cleanup);

const ITEMS = ['Alpha', 'Bravo', 'Charlie'];

function ListProbe({ onActivate }: { onActivate?: (index: number) => void }): ReactNode {
  const nav = useListNav({ count: ITEMS.length, ...(onActivate ? { onActivate } : {}) });
  return (
    <ul role="listbox" aria-label="demo" {...nav.containerProps}>
      {ITEMS.map((label, index) => (
        <li key={label} aria-label={label} {...nav.getItemProps(index)}>
          {label}
        </li>
      ))}
    </ul>
  );
}

function renderList(onActivate?: (index: number) => void) {
  return render(
    <KeyboardProvider>
      <ListProbe {...(onActivate ? { onActivate } : {})} />
    </KeyboardProvider>,
  );
}

describe('useListNav roving tabindex', () => {
  test('only the active item is in the tab order', () => {
    renderList();
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('tabindex', '0');
    expect(options[1]).toHaveAttribute('tabindex', '-1');
    expect(options[2]).toHaveAttribute('tabindex', '-1');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  test('j / k move selection, focus, and the roving tabindex', async () => {
    renderList();
    const options = screen.getAllByRole('option');

    await userEvent.tab();
    expect(options[0]).toHaveFocus();

    await userEvent.keyboard('j');
    expect(options[1]).toHaveFocus();
    expect(options[1]).toHaveAttribute('tabindex', '0');
    expect(options[0]).toHaveAttribute('tabindex', '-1');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('k');
    expect(options[0]).toHaveFocus();
    expect(options[0]).toHaveAttribute('tabindex', '0');
  });

  test('ArrowDown aliases j', async () => {
    renderList();
    const options = screen.getAllByRole('option');
    await userEvent.tab();
    await userEvent.keyboard('{ArrowDown}');
    expect(options[1]).toHaveFocus();
  });

  test('does not clamp past the ends (no loop by default)', async () => {
    renderList();
    const options = screen.getAllByRole('option');
    await userEvent.tab();
    await userEvent.keyboard('k'); // already at 0
    expect(options[0]).toHaveFocus();
  });

  test('Enter activates the focused item', async () => {
    const onActivate = vi.fn();
    renderList(onActivate);
    await userEvent.tab();
    await userEvent.keyboard('j');
    await userEvent.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledWith(1);
  });

  test('bindings are inert until the list is focused (scope guard)', async () => {
    renderList();
    const options = screen.getAllByRole('option');
    // no focus in the list yet → j must not move the selection
    await userEvent.keyboard('j');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
  });

  test('clicking an item selects and activates it', async () => {
    const onActivate = vi.fn();
    renderList(onActivate);
    await userEvent.click(screen.getByRole('option', { name: 'Charlie' }));
    expect(onActivate).toHaveBeenCalledWith(2);
    expect(screen.getByRole('option', { name: 'Charlie' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
