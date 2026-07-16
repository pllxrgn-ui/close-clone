import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx.ts';
import { useFloatingPosition } from './floating.ts';

/*
 * Action menu (dropdown) — trigger + portalled panel with full APG menu
 * keyboard support: ArrowUp/Down wrap, Home/End, Escape closes and restores
 * focus, Tab closes, click-outside closes, ArrowDown/ArrowUp on the trigger
 * opens focusing first/last item. Dependency-free like Modal. Not a select —
 * items run actions; for picking a value use <Select>.
 */

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
}

interface MenuContextValue {
  close: () => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

export interface MenuProps {
  /** Render the trigger button; spread the props onto a Button/IconButton. */
  trigger: (props: MenuTriggerProps) => ReactNode;
  /** Accessible name for the menu panel. */
  label: string;
  align?: 'start' | 'end';
  className?: string;
  children: ReactNode;
}

function menuItems(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
  );
}

export function Menu({
  trigger,
  label,
  align = 'start',
  className,
  children,
}: MenuProps): JSX.Element {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const focusEndRef = useRef<'first' | 'last'>('first');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const position = useFloatingPosition(open, triggerRef, panelRef, { side: 'bottom', align });

  function openMenu(end: 'first' | 'last'): void {
    focusEndRef.current = end;
    setOpen(true);
  }

  function close(restoreFocus = true): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  // Focus the first/last item once the panel exists.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = menuItems(panel);
    const target = focusEndRef.current === 'last' ? items[items.length - 1] : items[0];
    (target ?? panel).focus();
  }, [open]);

  // Click-outside closes without stealing the click's target interaction.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function onPanelKeyDown(event: ReactKeyboardEvent): void {
    const panel = panelRef.current;
    if (!panel) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      // A menu is not a tab stop container — close and let focus move on.
      close(false);
      return;
    }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const items = menuItems(panel);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === 'ArrowUp') {
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    } else if (event.key === 'Home') next = 0;
    else next = items.length - 1;
    items[next]?.focus();
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu('last');
    }
  }

  return (
    <MenuContext.Provider value={{ close }}>
      {trigger({
        ref: triggerRef,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
        onClick: () => (open ? close(false) : openMenu('first')),
        onKeyDown: onTriggerKeyDown,
      })}
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              className={cx('sb-menu', className)}
              data-side={position.side}
              data-align={align}
              style={position.style}
              onKeyDown={onPanelKeyDown}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </MenuContext.Provider>
  );
}

export interface MenuItemProps {
  onSelect: () => void;
  /** `danger` borrows the DNC hue — destructive actions only. */
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Leading icon slot (decorative — 16px lucide). */
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function MenuItem({
  onSelect,
  tone = 'default',
  disabled = false,
  icon,
  className,
  children,
}: MenuItemProps): JSX.Element {
  const menu = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      className={cx('sb-menu__item', tone === 'danger' && 'sb-menu__item--danger', className)}
      onClick={() => {
        if (disabled) return;
        menu?.close();
        onSelect();
      }}
    >
      {icon ? (
        <span className="sb-menu__item-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}

export function MenuSeparator(): JSX.Element {
  return <div role="separator" className="sb-menu__separator" />;
}
