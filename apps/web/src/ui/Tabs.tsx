import { createContext, useContext, useId, useMemo } from 'react';
import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';

/*
 * Controlled tabs with roving tabindex and automatic activation (arrow keys
 * move focus AND select — APG default for in-page tabs). Switching views is a
 * keyboard-frequency action, so there is NO animation on panel change (law §4).
 * `value` strings become element ids — keep them simple slugs.
 */

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(caller: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error(`${caller} must be used inside <Tabs>`);
  return context;
}

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  children: ReactNode;
}

export function Tabs({ value, onValueChange, className, children }: TabsProps): JSX.Element {
  const baseId = useId();
  const context = useMemo(() => ({ value, onValueChange, baseId }), [value, onValueChange, baseId]);
  return (
    <div className={cx('sb-tabs', className)}>
      <TabsContext.Provider value={context}>{children}</TabsContext.Provider>
    </div>
  );
}

export interface TabListProps {
  /** Accessible name for the tab strip. */
  label: string;
  className?: string;
  children: ReactNode;
}

export function TabList({ label, className, children }: TabListProps): JSX.Element {
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not(:disabled)'),
    );
    if (tabs.length === 0) return;
    event.preventDefault();
    const current = tabs.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (event.key === 'ArrowRight') next = current < 0 ? 0 : (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') {
      next = current < 0 ? tabs.length - 1 : (current - 1 + tabs.length) % tabs.length;
    } else if (event.key === 'Home') next = 0;
    else next = tabs.length - 1;
    tabs[next]?.focus();
    tabs[next]?.click();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx('sb-tablist', className)}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

export interface TabProps {
  value: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function Tab({ value, disabled = false, className, children }: TabProps): JSX.Element {
  const { value: selected, onValueChange, baseId } = useTabsContext('Tab');
  const isSelected = selected === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={isSelected}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={isSelected ? 0 : -1}
      disabled={disabled}
      className={cx('sb-tab', className)}
      onClick={() => onValueChange(value)}
    >
      {children}
    </button>
  );
}

export interface TabPanelProps {
  value: string;
  className?: string;
  children: ReactNode;
}

export function TabPanel({ value, className, children }: TabPanelProps): JSX.Element {
  const { value: selected, baseId } = useTabsContext('TabPanel');
  const isSelected = selected === value;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!isSelected}
      tabIndex={0}
      className={cx('sb-tabpanel', className)}
    >
      {isSelected ? children : null}
    </div>
  );
}
