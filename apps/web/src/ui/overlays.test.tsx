import { useState } from 'react';
import type { JSX } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button.tsx';
import { Drawer } from './Drawer.tsx';
import { Menu, MenuItem, MenuSeparator } from './Menu.tsx';
import { Tab, TabList, TabPanel, Tabs } from './Tabs.tsx';
import { Tooltip } from './Tooltip.tsx';

describe('Tooltip', () => {
  test('shows on focus, wires aria-describedby, hides on blur', async () => {
    render(
      <Tooltip content="Copy lead id">
        <Button>Copy</Button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Copy' });
    await userEvent.tab();
    expect(button).toHaveFocus();
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Copy lead id');
    expect(button).toHaveAttribute('aria-describedby', tip.id);
    await userEvent.tab();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  test('Escape dismisses an open tooltip', async () => {
    render(
      <Tooltip content="hint">
        <Button>Go</Button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  /** Fire pointerenter with a real pointerType (jsdom drops it from the option bag). */
  function pointerEnter(target: HTMLElement, pointerType: 'mouse' | 'touch'): void {
    const event = createEvent.pointerEnter(target);
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    fireEvent(target, event);
  }

  test('hover waits for the show delay (no flicker on pass-through)', () => {
    // Pin performance.now far from any prior hide so the instant window is closed.
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1e9);
    try {
      render(
        <Tooltip content="Later">
          <Button>Hover me</Button>
        </Tooltip>,
      );
      const button = screen.getByRole('button', { name: 'Hover me' });
      pointerEnter(button, 'mouse');
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      // failure path: leaving before the delay must cancel the show
      fireEvent.pointerLeave(button);
      vi.advanceTimersByTime(1000);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('touch pointers never summon a tooltip', () => {
    render(
      <Tooltip content="nope">
        <Button>Tap</Button>
      </Tooltip>,
    );
    pointerEnter(screen.getByRole('button'), 'touch');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

describe('Menu', () => {
  function renderMenu(onEdit = vi.fn(), onDelete = vi.fn()): { onEdit: typeof onEdit } {
    render(
      <Menu label="Lead actions" trigger={(props) => <Button {...props}>Actions</Button>}>
        <MenuItem onSelect={onEdit}>Edit</MenuItem>
        <MenuItem onSelect={() => {}} disabled>
          Merge
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={onDelete} tone="danger">
          Delete
        </MenuItem>
      </Menu>,
    );
    return { onEdit };
  }

  test('opens on click, focuses the first item, exposes menu roles', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu', { name: 'Lead actions' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  test('arrows skip disabled items and wrap; Home/End jump', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await userEvent.keyboard('{ArrowDown}');
    // Merge is disabled → focus lands on Delete
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
  });

  test('Enter selects: closes the menu, restores trigger focus, runs the action', async () => {
    const { onEdit } = renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await userEvent.keyboard('{Enter}');
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus();
  });

  test('Escape closes and restores focus without selecting', async () => {
    const { onEdit } = renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await userEvent.keyboard('{Escape}');
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus();
  });

  // failure path: a disabled item must not run its action
  test('clicking a disabled item does nothing', async () => {
    const onMerge = vi.fn();
    render(
      <Menu label="m" trigger={(props) => <Button {...props}>Open</Button>}>
        <MenuItem onSelect={onMerge} disabled>
          Merge
        </MenuItem>
      </Menu>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Merge' }));
    expect(onMerge).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  test('ArrowDown on the trigger opens focusing the first item', async () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
  });

  test('clicking outside closes the menu', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('Tabs', () => {
  function Harness(): JSX.Element {
    const [tab, setTab] = useState('calls');
    return (
      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="Report sections">
          <Tab value="calls">Calls</Tab>
          <Tab value="emails">Emails</Tab>
          <Tab value="sms" disabled>
            SMS
          </Tab>
        </TabList>
        <TabPanel value="calls">Call volume</TabPanel>
        <TabPanel value="emails">Email volume</TabPanel>
        <TabPanel value="sms">SMS volume</TabPanel>
      </Tabs>
    );
  }

  test('renders tablist semantics; only the active panel is visible', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Report sections' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Calls' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Call volume');
    expect(screen.queryByText('Email volume')).not.toBeInTheDocument();
  });

  test('click activates; panel is labelled by its tab', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('tab', { name: 'Emails' }));
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('Email volume');
    expect(panel).toHaveAccessibleName('Emails');
  });

  test('arrow keys move focus AND activate, skipping disabled tabs', async () => {
    render(<Harness />);
    const calls = screen.getByRole('tab', { name: 'Calls' });
    calls.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Emails' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Email volume');
    // SMS is disabled → wraps back to Calls
    await userEvent.keyboard('{ArrowRight}');
    expect(calls).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Call volume');
  });

  test('roving tabindex: only the selected tab is in the tab order', () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'Calls' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Emails' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('Drawer', () => {
  function Harness(): JSX.Element {
    const [open, setOpen] = useState(true);
    return (
      <Drawer open={open} onClose={() => setOpen(false)} label="Compose reply">
        <Button>Send</Button>
      </Drawer>
    );
  }

  test('is a modal dialog with the Modal focus/escape contract', async () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Compose reply' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('closed drawer renders nothing', () => {
    render(
      <Drawer open={false} onClose={() => {}} label="hidden">
        content
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
